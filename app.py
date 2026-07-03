import os, time, json, urllib.parse, urllib.request, csv, io, secrets, re, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, session
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import or_, func
from vocabulary_data import VOCABULARY, PHRASES

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = BASE_DIR
DB_URL = os.getenv('DATABASE_URL', 'sqlite:///' + os.path.join(BASE_DIR, 'data', 'lingoplay.db'))
if DB_URL.startswith('postgres://'):
    DB_URL = DB_URL.replace('postgres://', 'postgresql+psycopg://', 1)
elif DB_URL.startswith('postgresql://'):
    DB_URL = DB_URL.replace('postgresql://', 'postgresql+psycopg://', 1)

app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=os.getenv('SECRET_KEY', 'change-this-in-production-' + os.urandom(12).hex()),
    SQLALCHEMY_DATABASE_URI=DB_URL,
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.getenv('COOKIE_SECURE', '0') == '1',
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    MAX_CONTENT_LENGTH=20 * 1024 * 1024,
    SESSION_REFRESH_EACH_REQUEST=True,
)
db = SQLAlchemy(app)

class User(db.Model):
    id=db.Column(db.Integer, primary_key=True); name=db.Column(db.String(100), nullable=False)
    email=db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash=db.Column(db.String(255), nullable=False); role=db.Column(db.String(20), nullable=False, default='user')
    xp=db.Column(db.Integer, nullable=False, default=0); is_active=db.Column(db.Boolean, nullable=False, default=True)
    created_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
class Word(db.Model):
    id=db.Column(db.Integer, primary_key=True); language=db.Column(db.String(20), nullable=False, index=True)
    level=db.Column(db.String(20), nullable=False, index=True); word=db.Column(db.String(255), nullable=False, index=True)
    pronunciation=db.Column(db.String(255), default=''); meaning=db.Column(db.Text, nullable=False)
    example=db.Column(db.Text, default=''); topic=db.Column(db.String(100), default='general')
    created_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    __table_args__=(db.UniqueConstraint('language','level','word',name='uq_word_lang_level'),)
class Phrase(db.Model):
    id=db.Column(db.Integer, primary_key=True); language=db.Column(db.String(20), nullable=False)
    level=db.Column(db.String(20), nullable=False); phrase=db.Column(db.Text, nullable=False)
    meaning=db.Column(db.Text, nullable=False); created_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
class ApiCache(db.Model):
    id=db.Column(db.Integer, primary_key=True); cache_key=db.Column(db.String(500), unique=True, nullable=False, index=True)
    payload=db.Column(db.Text, nullable=False); expires_at=db.Column(db.DateTime, nullable=False)
class AuditLog(db.Model):
    id=db.Column(db.Integer, primary_key=True); user_id=db.Column(db.Integer, nullable=True)
    action=db.Column(db.String(100), nullable=False); detail=db.Column(db.Text, default='')
    created_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

class SecurityState(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, unique=True, nullable=False, index=True)
    failed_logins=db.Column(db.Integer, nullable=False, default=0)
    locked_until=db.Column(db.DateTime, nullable=True)
    session_version=db.Column(db.Integer, nullable=False, default=1)
    last_password_change=db.Column(db.DateTime, nullable=True)

class GameChallenge(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    token=db.Column(db.String(64), unique=True, nullable=False, index=True)
    user_id=db.Column(db.Integer, nullable=True, index=True)
    answer_word_id=db.Column(db.Integer, nullable=False)
    expires_at=db.Column(db.DateTime, nullable=False)
    used=db.Column(db.Boolean, nullable=False, default=False)


VALID_LEVELS = {
    "english": {"A1","A2","B1","B2","C1","C2"},
    "chinese": {"HSK1","HSK2","HSK3","HSK4","HSK5","HSK6"},
}
CSV_FIELDS = ["language","level","word","pronunciation","meaning","example","topic"]

def normalize_csv_row(row):
    cleaned = {k: str(row.get(k, "") or "").strip() for k in CSV_FIELDS}
    cleaned["language"] = cleaned["language"].lower()
    cleaned["level"] = cleaned["level"].upper().replace(" ", "")
    if cleaned["language"] not in VALID_LEVELS:
        return None, "Ngôn ngữ phải là english hoặc chinese"
    if cleaned["level"] not in VALID_LEVELS[cleaned["language"]]:
        return None, "Cấp độ không hợp lệ cho ngôn ngữ đã chọn"
    if not cleaned["word"] or not cleaned["meaning"]:
        return None, "Thiếu word hoặc meaning"
    
    for field in CSV_FIELDS:
        if cleaned[field].startswith(('=', '+', '-', '@')):
            cleaned[field] = "'" + cleaned[field]
    cleaned["word"] = cleaned["word"][:255]
    cleaned["pronunciation"] = cleaned["pronunciation"][:255]
    cleaned["meaning"] = cleaned["meaning"][:2000]
    cleaned["example"] = cleaned["example"][:2000]
    cleaned["topic"] = (cleaned["topic"] or "nhập CSV")[:100]
    return cleaned, None

RATE={}
def client_ip():
    forwarded=request.headers.get('X-Forwarded-For','').split(',')[0].strip()
    return forwarded or request.remote_addr or 'unknown'

def limited(bucket, max_calls=30, window=60):
    def deco(fn):
        @wraps(fn)
        def wrap(*a, **kw):
            key=(bucket, client_ip()); now=time.time(); arr=[x for x in RATE.get(key,[]) if now-x<window]
            if len(arr)>=max_calls: return jsonify(error='Bạn thao tác quá nhanh. Vui lòng thử lại sau.'),429
            arr.append(now); RATE[key]=arr
            return fn(*a, **kw)
        return wrap
    return deco

def security_state(user_id, create=True):
    row=SecurityState.query.filter_by(user_id=user_id).first()
    if not row and create:
        row=SecurityState(user_id=user_id)
        db.session.add(row); db.session.flush()
    return row

def current_user():
    uid=session.get('user_id')
    if not uid: return None
    u=db.session.get(User, uid)
    if not u or not u.is_active:
        session.clear(); return None
    state=security_state(u.id)
    if int(session.get('session_version',0)) != int(state.session_version):
        session.clear(); return None
    return u

def login_required(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        u=current_user()
        if not u: return jsonify(error='Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn'),401
        return fn(*a, **kw)
    return wrap

def admin_required(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        u=current_user()
        if not u: return jsonify(error='Bạn chưa đăng nhập'),401
        if u.role!='admin': return jsonify(error='Bạn không có quyền quản trị'),403
        return fn(*a, **kw)
    return wrap

def audit(action, detail=''):
    u=current_user()
    db.session.add(AuditLog(user_id=u.id if u else None, action=action[:100], detail=str(detail)[:2000]))

def password_is_strong(value):
    return (len(value)>=10 and re.search(r'[a-z]',value) and re.search(r'[A-Z]',value)
            and re.search(r'\d',value) and re.search(r'[^A-Za-z0-9]',value))

def csrf_token():
    token=session.get('csrf_token')
    if not token:
        token=secrets.token_urlsafe(32); session['csrf_token']=token
    return token

@app.before_request
def csrf_protection():
    if request.path.startswith('/api/') and request.method in {'POST','PUT','PATCH','DELETE'}:
        supplied=request.headers.get('X-CSRF-Token','')
        expected=session.get('csrf_token','')
        if not expected or not supplied or not secrets.compare_digest(str(expected),str(supplied)):
            return jsonify(error='Phiên bảo mật đã hết hạn. Hãy tải lại trang và thử lại.'),403

def user_json(u):
    return {'id':u.id,'name':u.name,'email':u.email,'role':u.role,'xp':u.xp,'is_active':u.is_active,'created_at':u.created_at.isoformat()}
def word_json(w):
    return {'id':w.id,'language':w.language,'level':w.level,'word':w.word,'pronunciation':w.pronunciation or '', 'meaning':w.meaning,'example':w.example or '', 'topic':w.topic or ''}

def ext_json(url, timeout=8):
    req=urllib.request.Request(url,headers={'User-Agent':'LingoPlay/2.0','Accept':'application/json'})
    with urllib.request.urlopen(req,timeout=timeout) as r: return json.loads(r.read().decode('utf-8'))
def cached(key, ttl, loader):
    now=datetime.now(timezone.utc)
    row=ApiCache.query.filter_by(cache_key=key).first()
    if row and row.expires_at.replace(tzinfo=timezone.utc)>now:
        return json.loads(row.payload)
    data=loader(); exp=now+timedelta(seconds=ttl)
    if row: row.payload=json.dumps(data,ensure_ascii=False); row.expires_at=exp
    else: db.session.add(ApiCache(cache_key=key,payload=json.dumps(data,ensure_ascii=False),expires_at=exp))
    db.session.commit(); return data

@app.after_request
def security_headers(resp):
    resp.headers['X-Content-Type-Options']='nosniff'
    resp.headers['X-Frame-Options']='DENY'
    resp.headers['Referrer-Policy']='strict-origin-when-cross-origin'
    resp.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=(), payment=()'
    resp.headers['Content-Security-Policy']=(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; media-src 'self' https:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    resp.headers['Cache-Control']='no-store' if request.path.startswith('/api/auth') or request.path.startswith('/api/security') else resp.headers.get('Cache-Control','')
    if request.is_secure: resp.headers['Strict-Transport-Security']='max-age=31536000; includeSubDomains'
    return resp

@app.route('/')
def home(): return send_from_directory(PUBLIC_DIR,'lingoplay-home.html')
@app.route('/<path:path>')
def static_files(path):
    if path.startswith('api/'): return jsonify(error='Không tìm thấy API'),404
    return send_from_directory(PUBLIC_DIR,path)

@app.get('/api/health')
def health():
    try: db.session.execute(db.text('SELECT 1')); ok=True
    except Exception: ok=False
    return jsonify(ok=ok, app='LingoPlay Production', database='postgresql' if DB_URL.startswith('postgresql') else 'sqlite')
@app.get('/api/security/csrf')
def get_csrf():
    return jsonify(csrf_token=csrf_token())

@app.get('/api/auth/me')
def me():
    u=current_user(); return jsonify(user=user_json(u) if u else None)

@app.post('/api/auth/register')
@limited('register',5,600)
def register():
    d=request.get_json(silent=True) or {}
    name=str(d.get('name','')).strip()[:100]
    email=str(d.get('email','')).strip().lower()[:255]
    pw=str(d.get('password',''))
    if len(name)<2 or len(name)>100 or '@' not in email:
        return jsonify(error='Họ tên hoặc email chưa hợp lệ.'),400
    if not password_is_strong(pw):
        return jsonify(error='Mật khẩu cần ít nhất 10 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.'),400
    if User.query.filter_by(email=email).first(): return jsonify(error='Email đã được sử dụng'),409
    u=User(name=name,email=email,password_hash=generate_password_hash(pw),role='user',xp=0)
    db.session.add(u); db.session.flush()
    state=security_state(u.id)
    audit('register',f'email={email}; ip={client_ip()}')
    db.session.commit()
    session.clear(); session.permanent=True
    session['user_id']=u.id; session['session_version']=state.session_version; session['csrf_token']=secrets.token_urlsafe(32)
    return jsonify(user=user_json(u),csrf_token=session['csrf_token']),201

@app.post('/api/auth/login')
@limited('login-ip',20,600)
def login():
    d=request.get_json(silent=True) or {}
    email=str(d.get('email','')).strip().lower()[:255]
    pw=str(d.get('password',''))
    u=User.query.filter_by(email=email).first()
    generic='Email hoặc mật khẩu không đúng'
    if not u:
        time.sleep(0.25); return jsonify(error=generic),401
    state=security_state(u.id)
    now=datetime.now(timezone.utc)
    locked=state.locked_until
    if locked and locked.tzinfo is None: locked=locked.replace(tzinfo=timezone.utc)
    if locked and locked>now:
        wait=max(1,int((locked-now).total_seconds()//60)+1)
        return jsonify(error=f'Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau {wait} phút.'),423
    if not check_password_hash(u.password_hash,pw):
        state.failed_logins += 1
        if state.failed_logins>=5:
            state.locked_until=now+timedelta(minutes=15); state.failed_logins=0
        audit('login_failed',f'user={u.id}; ip={client_ip()}')
        db.session.commit(); time.sleep(0.25)
        return jsonify(error=generic),401
    if not u.is_active: return jsonify(error='Tài khoản đang bị khóa'),403
    state.failed_logins=0; state.locked_until=None
    session.clear(); session.permanent=True
    session['user_id']=u.id; session['session_version']=state.session_version; session['csrf_token']=secrets.token_urlsafe(32)
    audit('login_success',f'ip={client_ip()}'); db.session.commit()
    return jsonify(user=user_json(u),csrf_token=session['csrf_token'])

@app.post('/api/auth/logout')
def logout():
    session.clear(); return jsonify(ok=True)

@app.post('/api/auth/change-password')
@login_required
@limited('change-password',5,600)
def change_password():
    u=current_user(); d=request.get_json(silent=True) or {}
    current=str(d.get('current_password','')); new=str(d.get('new_password','')); confirm=str(d.get('confirm_password',''))
    if not check_password_hash(u.password_hash,current): return jsonify(error='Mật khẩu hiện tại không đúng'),400
    if new!=confirm: return jsonify(error='Mật khẩu xác nhận không khớp'),400
    if not password_is_strong(new): return jsonify(error='Mật khẩu mới cần ít nhất 10 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.'),400
    if check_password_hash(u.password_hash,new): return jsonify(error='Mật khẩu mới phải khác mật khẩu hiện tại'),400
    u.password_hash=generate_password_hash(new)
    state=security_state(u.id); state.session_version+=1; state.last_password_change=datetime.now(timezone.utc)
    session['session_version']=state.session_version
    audit('password_changed',f'ip={client_ip()}'); db.session.commit()
    return jsonify(ok=True,message='Đổi mật khẩu thành công. Các thiết bị khác đã bị đăng xuất.')

@app.post('/api/auth/logout-all')
@login_required
def logout_all():
    u=current_user(); state=security_state(u.id); state.session_version+=1
    audit('logout_all',f'ip={client_ip()}'); db.session.commit(); session.clear()
    return jsonify(ok=True)

@app.get('/api/words')
def words():
    lang=request.args.get('language','english')[:20]; level=request.args.get('level','A1')[:20]; q=request.args.get('search','').strip()[:100]
    query=Word.query.filter_by(language=lang,level=level)
    if q: query=query.filter(or_(Word.word.ilike(f'%{q}%'),Word.meaning.ilike(f'%{q}%'),Word.topic.ilike(f'%{q}%')))
    return jsonify(items=[word_json(x) for x in query.order_by(Word.id.desc()).limit(300).all()])
@app.get('/api/phrases')
def phrases():
    lang=request.args.get('language','english'); level=request.args.get('level','A1')
    rows=Phrase.query.filter_by(language=lang,level=level).order_by(Phrase.id.desc()).limit(200).all()
    return jsonify(items=[{'id':x.id,'language':x.language,'level':x.level,'phrase':x.phrase,'meaning':x.meaning} for x in rows])
@app.post('/api/game/start')
@limited('game-start',30,60)
def game_start():
    d=request.get_json(silent=True) or {}
    lang=str(d.get('language','english'))[:20]
    level=str(d.get('level','A1')).upper().replace(' ','')[:20]
    rows=Word.query.filter_by(language=lang,level=level).order_by(func.random()).limit(12).all()
    if len(rows)<2: return jsonify(error='Cấp độ này chưa đủ từ để tạo trò chơi.'),400
    answer=rows[0]; distractors=rows[1:4]
    options=[answer]+distractors
    import random; random.shuffle(options)
    token=secrets.token_urlsafe(24)
    u=current_user()
    db.session.add(GameChallenge(token=token,user_id=u.id if u else None,answer_word_id=answer.id,expires_at=datetime.now(timezone.utc)+timedelta(minutes=5)))
    db.session.commit()
    return jsonify(token=token,word=answer.word,options=[{'id':x.id,'meaning':x.meaning} for x in options])

@app.post('/api/game/answer')
@limited('game-answer',60,60)
def game_answer():
    d=request.get_json(silent=True) or {}; token=str(d.get('token',''))[:64]
    try: answer_id=int(d.get('answer_id',0))
    except Exception: answer_id=0
    row=GameChallenge.query.filter_by(token=token).first()
    now=datetime.now(timezone.utc)
    if not row or row.used: return jsonify(error='Câu hỏi không còn hợp lệ.'),400
    expires=row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
    if expires<now: row.used=True; db.session.commit(); return jsonify(error='Câu hỏi đã hết hạn.'),400
    row.used=True; correct=answer_id==row.answer_word_id
    earned=0; u=current_user()
    if correct and u and row.user_id==u.id:
        u.xp+=10; earned=10
        audit('game_xp',f'challenge={row.id}; xp=10')
    correct_word=db.session.get(Word,row.answer_word_id)
    db.session.commit()
    return jsonify(correct=correct,earned_xp=earned,xp=u.xp if u else 0,correct_meaning=correct_word.meaning if correct_word else '')

@app.post('/api/progress/xp')
def deprecated_xp():
    return jsonify(error='API này đã bị khóa để chống gian lận XP.'),410
@app.post('/api/words/save')
@login_required
def save_word():
    d=request.get_json(silent=True) or {}; lang=str(d.get('language','english'))[:20]; level=str(d.get('level','A1'))[:20]; word=str(d.get('word','')).strip()[:255]; meaning=str(d.get('meaning','')).strip()[:2000]
    if not word or not meaning: return jsonify(error='Thiếu từ hoặc nghĩa'),400
    old=Word.query.filter(func.lower(Word.word)==word.lower(),Word.language==lang,Word.level==level).first()
    if old: return jsonify(item=word_json(old),already_exists=True)
    w=Word(language=lang,level=level,word=word,pronunciation=str(d.get('pronunciation',''))[:255],meaning=meaning,example=str(d.get('example',''))[:2000],topic=str(d.get('topic','tra từ API'))[:100]); db.session.add(w); db.session.commit(); return jsonify(item=word_json(w),already_exists=False),201

@app.get('/api/dictionary')
@limited('dictionary',40,60)
def dictionary():
    word=request.args.get('word','').strip()[:80]
    if not word: return jsonify(error='Hãy nhập từ cần tìm'),400
    local=[word_json(x) for x in Word.query.filter(or_(Word.word.ilike(f'%{word}%'),Word.meaning.ilike(f'%{word}%'))).limit(10).all()]
    def load():
        raw=ext_json('https://api.dictionaryapi.dev/api/v2/entries/en/'+urllib.parse.quote(word)); e=raw[0]
        meanings=[]; syn=[]; ant=[]
        for m in e.get('meanings',[]):
            defs=[]
            for d in m.get('definitions',[])[:5]:
                defs.append({'definition':d.get('definition',''),'example':d.get('example','')}); syn+=d.get('synonyms',[]); ant+=d.get('antonyms',[])
            meanings.append({'part_of_speech':m.get('partOfSpeech',''),'definitions':defs}); syn+=m.get('synonyms',[]); ant+=m.get('antonyms',[])
        phon=e.get('phonetic',''); audio=''
        for p in e.get('phonetics',[]):
            phon=phon or p.get('text',''); audio=audio or p.get('audio','')
        return {'word':e.get('word',word),'phonetic':phon,'audio':audio,'meanings':meanings,'synonyms':list(dict.fromkeys(syn))[:20],'antonyms':list(dict.fromkeys(ant))[:20],'source':'dictionaryapi'}
    try: result=cached('dict:'+word.lower(),86400*7,load)
    except Exception:
        if not local: return jsonify(error='Không tìm thấy từ này hoặc dịch vụ đang tạm lỗi'),404
        x=local[0]; result={'word':x['word'],'phonetic':x['pronunciation'],'audio':'','meanings':[{'part_of_speech':'Dữ liệu nội bộ','definitions':[{'definition':x['meaning'],'example':x['example']}]}],'synonyms':[],'antonyms':[],'source':'local'}
    try:
        tr=cached('tr:en:vi:'+word.lower(),86400*30,lambda: ext_json('https://api.mymemory.translated.net/get?'+urllib.parse.urlencode({'q':word,'langpair':'en|vi'})))
        result['translation']=tr.get('responseData',{}).get('translatedText','')
    except Exception: result['translation']=local[0]['meaning'] if local else ''
    result['local_items']=local; return jsonify(result)
@app.get('/api/suggestions')
@limited('suggestions',60,60)
def suggestions():
    q=request.args.get('q','').strip()[:60]
    if len(q)<2:return jsonify(items=[])
    try: data=cached('sug:'+q.lower(),86400,lambda: ext_json('https://api.datamuse.com/sug?'+urllib.parse.urlencode({'s':q,'max':10})))
    except Exception: data=[]
    local=[{'word':x.word,'score':0} for x in Word.query.filter(Word.word.ilike(q+'%')).limit(8).all()]
    merged=[]; seen=set()
    for x in data+local:
        w=x.get('word','')
        if w and w.lower() not in seen: seen.add(w.lower()); merged.append({'word':w})
    return jsonify(items=merged[:12])
@app.get('/api/related')
@limited('related',40,60)
def related():
    w=request.args.get('word','').strip()[:60]
    def dm(params):
        try:return cached('dm:'+urllib.parse.urlencode(params),86400*3,lambda: ext_json('https://api.datamuse.com/words?'+urllib.parse.urlencode(params)))
        except Exception:return []
    return jsonify(similar=[x.get('word') for x in dm({'ml':w,'max':10})],synonyms=[x.get('word') for x in dm({'rel_syn':w,'max':10})],antonyms=[x.get('word') for x in dm({'rel_ant':w,'max':10})])
@app.get('/api/translate')
@limited('translate',30,60)
def translate():
    text=request.args.get('text','').strip()[:500]; src=request.args.get('from','en'); dst=request.args.get('to','vi')
    allowed={'en','vi','zh-CN','zh'}
    if not text or src not in allowed or dst not in allowed:return jsonify(error='Dữ liệu dịch chưa hợp lệ'),400
    try:
        data=cached('tr:'+src+':'+dst+':'+text,86400*30,lambda: ext_json('https://api.mymemory.translated.net/get?'+urllib.parse.urlencode({'q':text,'langpair':src+'|'+dst})))
        out=data.get('responseData',{}).get('translatedText','')
        if not out:return jsonify(error='Không nhận được bản dịch'),502
        return jsonify(translated=out,source='MyMemory')
    except Exception:return jsonify(error='Dịch vụ dịch đang tạm lỗi. Hãy thử lại sau.'),503


LANGUAGE_TREND_PAGES = [
    ('english', 'Tiếng Anh', 'English_language', '🇬🇧'),
    ('chinese', 'Tiếng Trung', 'Chinese_language', '🇨🇳'),
    ('spanish', 'Tiếng Tây Ban Nha', 'Spanish_language', '🇪🇸'),
    ('japanese', 'Tiếng Nhật', 'Japanese_language', '🇯🇵'),
    ('korean', 'Tiếng Hàn', 'Korean_language', '🇰🇷'),
    ('french', 'Tiếng Pháp', 'French_language', '🇫🇷'),
    ('german', 'Tiếng Đức', 'German_language', '🇩🇪'),
]


def clean_news_title(title):
    title = str(title or '').strip()
    # Google News thường nối tên nguồn sau dấu " - ". Giữ tiêu đề gọn hơn.
    return title.rsplit(' - ', 1)[0].strip()[:220]


def format_news_time(value):
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return ''


def load_language_news():
    query = '(học tiếng Anh OR học tiếng Trung OR CEFR OR HSK OR ngoại ngữ)'
    url = 'https://news.google.com/rss/search?' + urllib.parse.urlencode({
        'q': query,
        'hl': 'vi',
        'gl': 'VN',
        'ceid': 'VN:vi',
    })
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 LingoPlay/2.0',
        'Accept': 'application/rss+xml, application/xml, text/xml',
    })
    with urllib.request.urlopen(req, timeout=12) as response:
        xml_data = response.read()
    root = ET.fromstring(xml_data)
    items = []
    for node in root.findall('./channel/item')[:18]:
        title = clean_news_title(node.findtext('title'))
        link = str(node.findtext('link') or '').strip()
        published = format_news_time(node.findtext('pubDate'))
        source_node = node.find('source')
        source = (source_node.text or '').strip() if source_node is not None else 'Google News'
        if title and link.startswith(('https://', 'http://')):
            items.append({
                'title': title,
                'url': link,
                'source': source[:100],
                'published_at': published,
            })
    return {'items': items, 'updated_at': datetime.now(timezone.utc).isoformat()}


def fetch_language_views(item, start, end):
    key, label, page, flag = item
    url = (
        'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/'
        'en.wikipedia/all-access/user/' + urllib.parse.quote(page, safe='') +
        '/daily/' + start + '/' + end
    )
    try:
        data = ext_json(url, timeout=12)
        total = sum(int(x.get('views', 0) or 0) for x in data.get('items', []))
    except Exception:
        total = 0
    return {'key': key, 'language': label, 'flag': flag, 'views': total}


def load_language_ranking():
    end_date = datetime.now(timezone.utc).date() - timedelta(days=1)
    start_date = end_date - timedelta(days=29)
    start = start_date.strftime('%Y%m%d') + '00'
    end = end_date.strftime('%Y%m%d') + '00'
    rows = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(fetch_language_views, item, start, end) for item in LANGUAGE_TREND_PAGES]
        for future in as_completed(futures):
            rows.append(future.result())
    rows.sort(key=lambda x: x['views'], reverse=True)
    for index, row in enumerate(rows, start=1):
        row['rank'] = index
    return {
        'items': rows,
        'period_start': start_date.isoformat(),
        'period_end': end_date.isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'metric': 'Lượt xem bài viết ngôn ngữ trên Wikipedia trong 30 ngày',
    }


@app.get('/api/language-news')
@limited('language-news', 30, 60)
def language_news():
    try:
        return jsonify(cached('language-news:vi', 1800, load_language_news))
    except Exception:
        return jsonify(items=[], updated_at='', warning='Nguồn tin đang tạm thời không phản hồi.')


@app.get('/api/language-ranking')
@limited('language-ranking', 30, 60)
def language_ranking():
    try:
        return jsonify(cached('language-ranking:30d', 21600, load_language_ranking))
    except Exception:
        return jsonify(items=[], updated_at='', metric='', warning='Chưa thể cập nhật bảng xu hướng lúc này.')


@app.get('/api/admin/stats')
@admin_required
def stats(): return jsonify(users=User.query.count(),words=Word.query.count(),phrases=Phrase.query.count(),active_users=User.query.filter_by(is_active=True).count())
@app.get('/api/admin/users')
@admin_required
def admin_users(): return jsonify(items=[user_json(x) for x in User.query.order_by(User.id.desc()).limit(500).all()])
@app.post('/api/admin/words')
@admin_required
def add_word():
    d=request.get_json(silent=True) or {}; word=str(d.get('word','')).strip(); meaning=str(d.get('meaning','')).strip()
    if not word or not meaning:return jsonify(error='Thiếu từ hoặc nghĩa'),400
    w=Word(language=str(d.get('language','english')),level=str(d.get('level','A1')),word=word,pronunciation=str(d.get('pronunciation','')),meaning=meaning,example=str(d.get('example','')),topic=str(d.get('topic','general')))
    try: db.session.add(w); db.session.commit()
    except Exception: db.session.rollback(); return jsonify(error='Từ này đã tồn tại ở cấp độ đã chọn'),409
    return jsonify(item=word_json(w)),201

@app.get('/api/admin/words/template.csv')
@admin_required
def download_word_template():
    sample = [
        {"language":"english","level":"A1","word":"apple","pronunciation":"/ˈæp.əl/","meaning":"quả táo","example":"I eat an apple every day.","topic":"food"},
        {"language":"chinese","level":"HSK1","word":"你好","pronunciation":"nǐ hǎo","meaning":"xin chào","example":"你好，很高兴认识你。","topic":"greeting"},
    ]
    out=io.StringIO(); writer=csv.DictWriter(out,fieldnames=CSV_FIELDS); writer.writeheader(); writer.writerows(sample)
    return app.response_class(out.getvalue(), mimetype='text/csv; charset=utf-8', headers={'Content-Disposition':'attachment; filename=lingoplay-vocabulary-template.csv'})

@app.get('/api/admin/words/export.csv')
@admin_required
def export_words_csv():
    out=io.StringIO(); writer=csv.DictWriter(out,fieldnames=CSV_FIELDS); writer.writeheader()
    for w in Word.query.order_by(Word.language,Word.level,Word.word).all():
        writer.writerow({k:getattr(w,k,'') or '' for k in CSV_FIELDS})
    return app.response_class(out.getvalue(), mimetype='text/csv; charset=utf-8', headers={'Content-Disposition':'attachment; filename=lingoplay-vocabulary-export.csv'})

@app.post('/api/admin/words/import')
@admin_required
@limited('csv-import',6,300)
def import_words_csv():
    f=request.files.get('file')
    if not f or not f.filename.lower().endswith('.csv'):
        return jsonify(error='Hãy chọn file CSV hợp lệ'),400
    update_existing=str(request.form.get('update_existing','false')).lower() in ('1','true','yes','on')
    try:
        raw=f.read().decode('utf-8-sig')
    except UnicodeDecodeError:
        return jsonify(error='File phải dùng mã UTF-8'),400
    reader=csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames or not {'language','level','word','meaning'}.issubset({x.strip() for x in reader.fieldnames}):
        return jsonify(error='CSV thiếu cột bắt buộc: language, level, word, meaning'),400
    added=updated=skipped=0; errors=[]
    for line_no,row in enumerate(reader,start=2):
        data,err=normalize_csv_row(row)
        if err:
            if len(errors)<30: errors.append({'line':line_no,'error':err})
            skipped+=1; continue
        old=Word.query.filter(func.lower(Word.word)==data['word'].lower(),Word.language==data['language'],Word.level==data['level']).first()
        if old:
            if update_existing:
                old.pronunciation=data['pronunciation']; old.meaning=data['meaning']; old.example=data['example']; old.topic=data['topic']; updated+=1
            else: skipped+=1
            continue
        db.session.add(Word(**data)); added+=1
        if (added+updated)%300==0: db.session.flush()
    db.session.add(AuditLog(user_id=current_user().id,action='import_words_csv',detail=json.dumps({'filename':f.filename,'added':added,'updated':updated,'skipped':skipped},ensure_ascii=False)))
    db.session.commit()
    return jsonify(ok=True,added=added,updated=updated,skipped=skipped,errors=errors,total=Word.query.count())

@app.delete('/api/admin/words/<int:wid>')
@admin_required
def delete_word(wid):
    w=db.session.get(Word,wid)
    if not w:return jsonify(error='Không tìm thấy từ'),404
    db.session.delete(w); db.session.commit(); return jsonify(ok=True)
@app.patch('/api/admin/users/<int:uid>')
@admin_required
def update_user(uid):
    u=db.session.get(User,uid)
    if not u:return jsonify(error='Không tìm thấy người dùng'),404
    d=request.get_json(silent=True) or {}
    if 'is_active' in d:u.is_active=bool(d['is_active'])
    if d.get('role') in ('user','admin') and uid!=current_user().id:u.role=d['role']
    db.session.add(AuditLog(user_id=current_user().id,action='update_user',detail=f'user={uid}')); db.session.commit(); return jsonify(user=user_json(u))

def seed():
    os.makedirs(os.path.join(BASE_DIR,'data'),exist_ok=True); db.create_all()
    admin_email=os.getenv('ADMIN_EMAIL','').strip().lower(); admin_pw=os.getenv('ADMIN_PASSWORD','')
    if admin_email and admin_pw and not User.query.filter_by(email=admin_email).first():
        if password_is_strong(admin_pw): db.session.add(User(name='Quản trị viên',email=admin_email,password_hash=generate_password_hash(admin_pw),role='admin',xp=0))
        else: app.logger.warning('ADMIN_PASSWORD chưa đủ mạnh; không tạo admin mới.')
    demo=User.query.filter_by(email='user@lingoplay.local').first()
    if demo: db.session.delete(demo)
    for s in VOCABULARY:
        if not Word.query.filter_by(language=s[0],level=s[1],word=s[2]).first():
            db.session.add(Word(language=s[0],level=s[1],word=s[2],pronunciation=s[3],meaning=s[4],example=s[5],topic=s[6]))
    for p in PHRASES:
        if not Phrase.query.filter_by(language=p[0],level=p[1],phrase=p[2]).first():
            db.session.add(Phrase(language=p[0],level=p[1],phrase=p[2],meaning=p[3]))
    db.session.flush()
    for user in User.query.all(): security_state(user.id)
    GameChallenge.query.filter(GameChallenge.expires_at < datetime.now(timezone.utc)-timedelta(days=1)).delete(synchronize_session=False)
    db.session.commit()

with app.app_context(): seed()
if __name__=='__main__': app.run(host='127.0.0.1',port=int(os.getenv('PORT','3000')),debug=False)
import os, time, json, urllib.parse, urllib.request, csv, io, secrets, re, smtplib, ssl, hashlib, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from email.message import EmailMessage
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
    SECRET_KEY=os.getenv('SECRET_KEY') or hashlib.sha256((DB_URL + '|' + os.getenv('ADMIN_EMAIL','') + '|lingoplay-session-v1').encode('utf-8')).hexdigest(),
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


class PasswordReset(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, nullable=False, index=True)
    code_hash=db.Column(db.String(255), nullable=False)
    expires_at=db.Column(db.DateTime, nullable=False)
    used=db.Column(db.Boolean, nullable=False, default=False)
    attempts=db.Column(db.Integer, nullable=False, default=0)
    requested_ip=db.Column(db.String(100), default='')
    created_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

class LearnedWord(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, nullable=False, index=True)
    word_id=db.Column(db.Integer, nullable=False, index=True)
    strength=db.Column(db.Integer, nullable=False, default=0)
    correct_count=db.Column(db.Integer, nullable=False, default=0)
    wrong_count=db.Column(db.Integer, nullable=False, default=0)
    learned_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    last_reviewed_at=db.Column(db.DateTime, nullable=True)
    next_review_at=db.Column(db.DateTime, nullable=True, index=True)
    __table_args__=(db.UniqueConstraint('user_id','word_id',name='uq_learned_user_word'),)


class StudyStat(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, unique=True, nullable=False, index=True)
    total_seconds=db.Column(db.Integer, nullable=False, default=0)
    lessons_completed=db.Column(db.Integer, nullable=False, default=0)
    updated_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

class ReviewChallenge(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    token=db.Column(db.String(64), unique=True, nullable=False, index=True)
    user_id=db.Column(db.Integer, nullable=False, index=True)
    learned_id=db.Column(db.Integer, nullable=False, index=True)
    answer_word_id=db.Column(db.Integer, nullable=False)
    expires_at=db.Column(db.DateTime, nullable=False)
    used=db.Column(db.Boolean, nullable=False, default=False)

class GameChallenge(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    token=db.Column(db.String(64), unique=True, nullable=False, index=True)
    user_id=db.Column(db.Integer, nullable=True, index=True)
    answer_word_id=db.Column(db.Integer, nullable=False)
    expires_at=db.Column(db.DateTime, nullable=False)
    used=db.Column(db.Boolean, nullable=False, default=False)


class DailyActivity(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, nullable=False, index=True)
    activity_date=db.Column(db.Date, nullable=False, index=True)
    seconds=db.Column(db.Integer, nullable=False, default=0)
    lessons=db.Column(db.Integer, nullable=False, default=0)
    xp_earned=db.Column(db.Integer, nullable=False, default=0)
    __table_args__=(db.UniqueConstraint('user_id','activity_date',name='uq_daily_activity_user_date'),)

class LessonProgress(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, nullable=False, index=True)
    language=db.Column(db.String(20), nullable=False)
    level=db.Column(db.String(20), nullable=False)
    lesson_number=db.Column(db.Integer, nullable=False)
    best_score=db.Column(db.Integer, nullable=False, default=0)
    completed=db.Column(db.Boolean, nullable=False, default=False)
    attempts=db.Column(db.Integer, nullable=False, default=0)
    updated_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    __table_args__=(db.UniqueConstraint('user_id','language','level','lesson_number',name='uq_lesson_progress'),)

class BadgeAward(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, nullable=False, index=True)
    badge_key=db.Column(db.String(60), nullable=False)
    awarded_at=db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    __table_args__=(db.UniqueConstraint('user_id','badge_key',name='uq_badge_award'),)

class ProfileSetting(db.Model):
    id=db.Column(db.Integer, primary_key=True)
    user_id=db.Column(db.Integer, unique=True, nullable=False, index=True)
    daily_goal_minutes=db.Column(db.Integer, nullable=False, default=10)
    preferred_language=db.Column(db.String(20), nullable=False, default='english')
    timezone_name=db.Column(db.String(60), nullable=False, default='Asia/Ho_Chi_Minh')

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


def notify_admin(title, message):
    topic=os.getenv('NTFY_TOPIC','').strip()
    if not topic: return False
    server=os.getenv('NTFY_SERVER','https://ntfy.sh').rstrip('/')
    try:
        req=urllib.request.Request(f"{server}/{urllib.parse.quote(topic, safe='')}", data=message.encode('utf-8'), method='POST', headers={'Title':title,'Priority':'high','Tags':'key,warning'})
        with urllib.request.urlopen(req, timeout=8): pass
        return True
    except Exception as exc:
        app.logger.warning('Không gửi được ntfy: %s', exc)
        return False

def send_reset_email(to_email, code):
    host=os.getenv('SMTP_HOST','').strip(); user=os.getenv('SMTP_USER','').strip(); password=os.getenv('SMTP_PASSWORD','')
    
    try: port=int(os.getenv('SMTP_PORT','587'))
    except ValueError: port=587
    sender=os.getenv('SMTP_FROM',user).strip()
    if not host or not user or not password or not sender: return False
    msg=EmailMessage(); msg['Subject']='Mã đặt lại mật khẩu LingoPlay'; msg['From']=sender; msg['To']=to_email
    msg.set_content(f'Mã đặt lại mật khẩu của bạn là: {code}\nMã có hiệu lực trong 15 phút. Không chia sẻ mã này với người khác.')
    try:
        context=ssl.create_default_context()
        with smtplib.SMTP(host,port,timeout=12) as smtp:
            smtp.starttls(context=context); smtp.login(user,password); smtp.send_message(msg)
        return True
    except Exception as exc:
        app.logger.warning('Không gửi được email reset: %s', exc)
        return False

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


@app.post('/api/auth/forgot-password')
@limited('forgot-password',5,900)
def forgot_password():
    d=request.get_json(silent=True) or {}
    email=str(d.get('email','')).strip().lower()[:255]
    generic='Nếu email tồn tại, hệ thống đã gửi hướng dẫn đặt lại mật khẩu.'
    u=User.query.filter_by(email=email).first()
    if not u:
        time.sleep(0.3); return jsonify(ok=True,message=generic)
    PasswordReset.query.filter_by(user_id=u.id,used=False).update({'used':True})
    code=f'{secrets.randbelow(1000000):06d}'
    row=PasswordReset(user_id=u.id,code_hash=generate_password_hash(code),expires_at=datetime.now(timezone.utc)+timedelta(minutes=15),requested_ip=client_ip())
    db.session.add(row); audit('password_reset_requested',f'user={u.id}; ip={client_ip()}'); db.session.commit()
    delivered=send_reset_email(u.email,code)
    masked=(u.email[:2]+'***@'+u.email.split('@',1)[1]) if '@' in u.email else 'email ẩn'
    notify_admin('LingoPlay: yêu cầu quên mật khẩu',f'Có yêu cầu đặt lại mật khẩu cho {masked}. Email gửi mã: {"thành công" if delivered else "chưa cấu hình hoặc thất bại"}. IP: {client_ip()}')
    return jsonify(ok=True,message=generic,delivery_configured=delivered)

@app.post('/api/auth/reset-password')
@limited('reset-password',10,900)
def reset_password():
    d=request.get_json(silent=True) or {}
    email=str(d.get('email','')).strip().lower()[:255]
    code=str(d.get('code','')).strip()[:12]
    new=str(d.get('new_password','')); confirm=str(d.get('confirm_password',''))
    if new!=confirm: return jsonify(error='Mật khẩu xác nhận không khớp'),400
    if not password_is_strong(new): return jsonify(error='Mật khẩu mới cần ít nhất 10 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.'),400
    u=User.query.filter_by(email=email).first()
    if not u: return jsonify(error='Mã đặt lại không hợp lệ hoặc đã hết hạn.'),400
    row=PasswordReset.query.filter_by(user_id=u.id,used=False).order_by(PasswordReset.id.desc()).first()
    now=datetime.now(timezone.utc)
    if not row: return jsonify(error='Mã đặt lại không hợp lệ hoặc đã hết hạn.'),400
    exp=row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
    if exp<now or row.attempts>=5:
        row.used=True; db.session.commit(); return jsonify(error='Mã đặt lại không hợp lệ hoặc đã hết hạn.'),400
    if not check_password_hash(row.code_hash,code):
        row.attempts+=1; db.session.commit(); return jsonify(error='Mã đặt lại không hợp lệ hoặc đã hết hạn.'),400
    row.used=True; u.password_hash=generate_password_hash(new)
    state=security_state(u.id); state.session_version+=1; state.last_password_change=now
    audit('password_reset_completed',f'user={u.id}; ip={client_ip()}'); db.session.commit()
    notify_admin('LingoPlay: đặt lại mật khẩu thành công',f'Tài khoản {u.email[:2]}*** đã đặt lại mật khẩu thành công.')
    return jsonify(ok=True,message='Đặt lại mật khẩu thành công. Bạn có thể đăng nhập bằng mật khẩu mới.')

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
TOPIC_GROUPS = {
    'daily': {'name':'Hằng ngày','description':'Những từ dùng thường xuyên trong sinh hoạt mỗi ngày.','keywords':['daily','everyday','routine','hằng ngày','hang ngay','sinh hoạt','cuộc sống']},
    'travel': {'name':'Du lịch','description':'Sân bay, khách sạn, phương tiện và hỏi đường.','keywords':['travel','tourism','trip','du lịch','du lich','hotel','airport','transport']},
    'greetings': {'name':'Chào hỏi & giao tiếp','description':'Chào hỏi, giới thiệu bản thân và hội thoại cơ bản.','keywords':['greeting','conversation','communication','chào hỏi','chao hoi','giao tiếp','introduction']},
    'food': {'name':'Ăn uống','description':'Thực phẩm, nhà hàng, đồ uống và gọi món.','keywords':['food','drink','restaurant','meal','ăn uống','an uong','thực phẩm','đồ ăn']},
    'shopping': {'name':'Mua sắm','description':'Cửa hàng, giá cả, quần áo và thanh toán.','keywords':['shopping','shop','store','money','mua sắm','mua sam','siêu thị','price']},
    'family': {'name':'Gia đình & con người','description':'Gia đình, bạn bè, ngoại hình và tính cách.','keywords':['family','people','friend','relationship','gia đình','gia dinh','con người']},
    'school': {'name':'Trường học','description':'Lớp học, môn học, thi cử và dụng cụ học tập.','keywords':['school','education','study','class','trường học','truong hoc','giáo dục']},
    'work': {'name':'Công việc','description':'Nghề nghiệp, văn phòng, phỏng vấn và kinh doanh.','keywords':['work','job','career','office','business','công việc','cong viec','nghề nghiệp']},
    'health': {'name':'Sức khỏe','description':'Cơ thể, bệnh viện, cảm xúc và chăm sóc sức khỏe.','keywords':['health','body','hospital','doctor','sức khỏe','suc khoe','y tế']},
    'technology': {'name':'Công nghệ','description':'Máy tính, Internet, điện thoại và trí tuệ nhân tạo.','keywords':['technology','computer','internet','digital','ai','công nghệ','cong nghe']},
    'nature': {'name':'Thiên nhiên','description':'Thời tiết, động vật, môi trường và cảnh quan.','keywords':['nature','weather','animal','environment','thiên nhiên','thien nhien','môi trường']},
    'time': {'name':'Thời gian & số đếm','description':'Ngày tháng, giờ giấc, số và tần suất.','keywords':['time','number','date','calendar','thời gian','thoi gian','số đếm']},
}

def topic_filter(query, category):
    info=TOPIC_GROUPS.get(category)
    if not info: return query
    conditions=[Word.topic.ilike(f'%{k}%') for k in info['keywords']]
    return query.filter(or_(*conditions))

@app.get('/api/topics')
def topic_catalog():
    lang=request.args.get('language','english')[:20]
    level=request.args.get('level','').strip()[:20]
    result=[]
    for key,info in TOPIC_GROUPS.items():
        query=Word.query.filter_by(language=lang)
        if level:
            if lang=='chinese' and level.startswith('HSK') and ' ' not in level:
                query=query.filter(or_(Word.level==level,Word.level==level.replace('HSK','HSK ')))
            else: query=query.filter_by(level=level)
        query=topic_filter(query,key)
        count=query.count()
        result.append({'key':key,'name':info['name'],'description':info['description'],'count':count})
    return jsonify(items=result)

@app.get('/api/topic-words')
def topic_words():
    lang=request.args.get('language','english')[:20]
    level=request.args.get('level','').strip()[:20]
    category=request.args.get('category','daily')[:30]
    search=request.args.get('search','').strip()[:100]
    if category not in TOPIC_GROUPS: return jsonify(error='Chủ đề không hợp lệ'),400
    query=Word.query.filter_by(language=lang)
    if level:
        if lang=='chinese' and level.startswith('HSK') and ' ' not in level:
            query=query.filter(or_(Word.level==level,Word.level==level.replace('HSK','HSK ')))
        else: query=query.filter_by(level=level)
    query=topic_filter(query,category)
    if search: query=query.filter(or_(Word.word.ilike(f'%{search}%'),Word.meaning.ilike(f'%{search}%'),Word.example.ilike(f'%{search}%')))
    rows=query.order_by(Word.level.asc(),Word.id.asc()).limit(500).all()
    info=TOPIC_GROUPS[category]
    return jsonify(category={'key':category,'name':info['name'],'description':info['description']},items=[word_json(x) for x in rows])

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
    u=current_user()
    earned=0
    if correct and u and row.user_id==u.id:
        u.xp+=10; earned=10
        record_activity(u.id,xp=10)
        audit('game_xp',f'challenge={row.id}; xp=10')
    correct_word=db.session.get(Word,row.answer_word_id)
    db.session.commit()
    return jsonify(correct=correct,earned_xp=earned,xp=u.xp if u else 0,correct_meaning=correct_word.meaning if correct_word else '')



def daily_activity(user_id, day=None):
    day=day or datetime.now(timezone.utc).date()
    row=DailyActivity.query.filter_by(user_id=user_id,activity_date=day).first()
    if not row:
        row=DailyActivity(user_id=user_id,activity_date=day)
        db.session.add(row); db.session.flush()
    return row

def profile_setting(user_id):
    row=ProfileSetting.query.filter_by(user_id=user_id).first()
    if not row:
        row=ProfileSetting(user_id=user_id)
        db.session.add(row); db.session.flush()
    return row

def record_activity(user_id, seconds=0, lessons=0, xp=0):
    row=daily_activity(user_id)
    row.seconds=max(0,int(row.seconds or 0)+max(0,int(seconds or 0)))
    row.lessons=max(0,int(row.lessons or 0)+max(0,int(lessons or 0)))
    row.xp_earned=max(0,int(row.xp_earned or 0)+max(0,int(xp or 0)))
    return row

def streak_days(user_id):
    dates={x.activity_date for x in DailyActivity.query.filter_by(user_id=user_id).filter(DailyActivity.seconds>0).all()}
    cur=datetime.now(timezone.utc).date(); streak=0
    while cur in dates:
        streak+=1; cur-=timedelta(days=1)
    return streak

BADGE_DEFS={
 'first_lesson':('Bước đầu tiên','Hoàn thành bài học đầu tiên','footprints'),
 'streak_3':('Kiên trì 3 ngày','Học liên tục 3 ngày','flame'),
 'streak_7':('Tuần lễ chăm chỉ','Học liên tục 7 ngày','trophy'),
 'words_50':('Nhà sưu tầm từ','Đã học 50 từ','book-marked'),
 'xp_500':('Chiến binh XP','Đạt 500 XP','zap'),
}

def sync_badges(user):
    keys=set()
    stat=study_stat(user.id)
    learned=LearnedWord.query.filter_by(user_id=user.id).count()
    streak=streak_days(user.id)
    if (stat.lessons_completed or 0)>=1: keys.add('first_lesson')
    if streak>=3: keys.add('streak_3')
    if streak>=7: keys.add('streak_7')
    if learned>=50: keys.add('words_50')
    if (user.xp or 0)>=500: keys.add('xp_500')
    existing={x.badge_key for x in BadgeAward.query.filter_by(user_id=user.id).all()}
    for key in keys-existing: db.session.add(BadgeAward(user_id=user.id,badge_key=key))
    return keys|existing

def study_stat(user_id):
    row=StudyStat.query.filter_by(user_id=user_id).first()
    if not row:
        row=StudyStat(user_id=user_id)
        db.session.add(row)
        db.session.flush()
    return row

def study_stats_json(row):
    total=max(0,int(row.total_seconds or 0))
    return {
        'total_seconds': total,
        'total_minutes': total // 60,
        'total_hours': round(total / 3600, 1),
        'lessons_completed': int(row.lessons_completed or 0),
    }

@app.get('/api/study/stats')
@login_required
def get_study_stats():
    u=current_user(); row=study_stat(u.id); db.session.commit()
    return jsonify(**study_stats_json(row))

@app.post('/api/study/heartbeat')
@login_required
@limited('study-heartbeat',30,60)
def study_heartbeat():
    u=current_user(); data=request.get_json(silent=True) or {}
    try: seconds=int(data.get('seconds',0))
    except (TypeError,ValueError): seconds=0
    seconds=max(0,min(seconds,90))
    row=study_stat(u.id)
    if seconds:
        row.total_seconds=(row.total_seconds or 0)+seconds
        row.updated_at=datetime.now(timezone.utc)
        record_activity(u.id,seconds=seconds)
    db.session.commit()
    return jsonify(ok=True,**study_stats_json(row))

def register_completed_lesson(user_id):
    row=study_stat(user_id)
    row.lessons_completed=(row.lessons_completed or 0)+1
    row.updated_at=datetime.now(timezone.utc)
    record_activity(user_id,lessons=1)

def learned_json(row, word):
    now=datetime.now(timezone.utc)
    due=True
    if row.next_review_at:
        nxt=row.next_review_at.replace(tzinfo=timezone.utc) if row.next_review_at.tzinfo is None else row.next_review_at
        due=nxt<=now
    return {'id':row.id,'word_id':word.id,'language':word.language,'level':word.level,'word':word.word,
            'pronunciation':word.pronunciation,'meaning':word.meaning,'example':word.example,'topic':word.topic,
            'strength':row.strength,'correct_count':row.correct_count,'wrong_count':row.wrong_count,
            'due':due,'learned_at':row.learned_at.isoformat() if row.learned_at else None,
            'next_review_at':row.next_review_at.isoformat() if row.next_review_at else None}

@app.get('/api/learned')
@login_required
def learned_list():
    u=current_user(); lang=request.args.get('language','').strip(); level=request.args.get('level','').strip(); q=request.args.get('search','').strip()[:100]
    query=db.session.query(LearnedWord,Word).join(Word,Word.id==LearnedWord.word_id).filter(LearnedWord.user_id==u.id)
    if lang: query=query.filter(Word.language==lang)
    if level: query=query.filter(Word.level==level)
    if q: query=query.filter(or_(Word.word.ilike(f'%{q}%'),Word.meaning.ilike(f'%{q}%'),Word.topic.ilike(f'%{q}%')))
    rows=query.order_by(LearnedWord.next_review_at.asc().nullsfirst(),LearnedWord.learned_at.desc()).limit(1000).all()
    items=[learned_json(l,w) for l,w in rows]
    return jsonify(items=items,total=len(items),due=sum(1 for x in items if x['due']),mastered=sum(1 for x in items if x['strength']>=4))

@app.post('/api/learned/<int:word_id>')
@login_required
def learned_add(word_id):
    u=current_user(); w=db.session.get(Word,word_id)
    if not w:return jsonify(error='Không tìm thấy từ vựng'),404
    row=LearnedWord.query.filter_by(user_id=u.id,word_id=word_id).first()
    if not row:
        row=LearnedWord(user_id=u.id,word_id=word_id,next_review_at=datetime.now(timezone.utc))
        db.session.add(row); audit('learned_word_add',f'word={word_id}')
    db.session.commit(); return jsonify(ok=True,item=learned_json(row,w))

@app.delete('/api/learned/<int:word_id>')
@login_required
def learned_remove(word_id):
    u=current_user(); row=LearnedWord.query.filter_by(user_id=u.id,word_id=word_id).first()
    if row: db.session.delete(row); audit('learned_word_remove',f'word={word_id}'); db.session.commit()
    return jsonify(ok=True)

@app.post('/api/review/start')
@login_required
@limited('review-start',40,60)
def review_start():
    u=current_user(); d=request.get_json(silent=True) or {}; lang=str(d.get('language','')).strip(); level=str(d.get('level','')).strip()
    now=datetime.now(timezone.utc)
    query=db.session.query(LearnedWord,Word).join(Word,Word.id==LearnedWord.word_id).filter(LearnedWord.user_id==u.id)
    if lang: query=query.filter(Word.language==lang)
    if level: query=query.filter(Word.level==level)
    due_filter=or_(LearnedWord.next_review_at==None,LearnedWord.next_review_at<=now)
    pair=query.filter(due_filter).order_by(func.random()).first() or query.order_by(func.random()).first()
    if not pair:return jsonify(error='Bạn chưa có từ đã học. Hãy vào Kho từ vựng và bấm “Đã học”.'),400
    learned,answer=pair
    distractors=Word.query.filter(Word.language==answer.language,Word.level==answer.level,Word.id!=answer.id).order_by(func.random()).limit(3).all()
    options=[answer]+distractors
    import random; random.shuffle(options)
    token=secrets.token_urlsafe(24)
    db.session.add(ReviewChallenge(token=token,user_id=u.id,learned_id=learned.id,answer_word_id=answer.id,expires_at=now+timedelta(minutes=5)))
    db.session.commit()
    return jsonify(token=token,word=answer.word,pronunciation=answer.pronunciation,options=[{'id':x.id,'meaning':x.meaning} for x in options],strength=learned.strength)

@app.post('/api/review/answer')
@login_required
@limited('review-answer',80,60)
def review_answer():
    u=current_user(); d=request.get_json(silent=True) or {}; token=str(d.get('token',''))[:64]
    try: answer_id=int(d.get('answer_id',0))
    except Exception: answer_id=0
    row=ReviewChallenge.query.filter_by(token=token,user_id=u.id).first(); now=datetime.now(timezone.utc)
    if not row or row.used:return jsonify(error='Câu ôn tập không còn hợp lệ.'),400
    exp=row.expires_at.replace(tzinfo=timezone.utc) if row.expires_at.tzinfo is None else row.expires_at
    if exp<now: row.used=True; db.session.commit(); return jsonify(error='Câu ôn tập đã hết hạn.'),400
    learned=db.session.get(LearnedWord,row.learned_id); correct=answer_id==row.answer_word_id; row.used=True
    if not learned:return jsonify(error='Từ này không còn trong danh sách đã học.'),404
    learned.last_reviewed_at=now
    if correct:
        learned.correct_count+=1; learned.strength=min(5,learned.strength+1)
        days=[1,2,4,7,14,30][learned.strength]
        learned.next_review_at=now+timedelta(days=days); u.xp+=5; record_activity(u.id,xp=5)
    else:
        learned.wrong_count+=1; learned.strength=max(0,learned.strength-1); learned.next_review_at=now+timedelta(minutes=10)
    correct_word=db.session.get(Word,row.answer_word_id); audit('review_answer',f'word={row.answer_word_id}; correct={correct}')
    db.session.commit()
    return jsonify(correct=correct,earned_xp=5 if correct else 0,xp=u.xp,strength=learned.strength,
                   correct_meaning=correct_word.meaning if correct_word else '',next_review_at=learned.next_review_at.isoformat())

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
@app.get('/api/lookup')
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


@app.get('/api/dashboard/summary')
@login_required
def dashboard_summary():
    u=current_user(); setting=profile_setting(u.id); stat=study_stat(u.id)
    today=datetime.now(timezone.utc).date(); monday=today-timedelta(days=today.weekday())
    week=DailyActivity.query.filter(DailyActivity.user_id==u.id,DailyActivity.activity_date>=monday).all()
    keys=sync_badges(u); db.session.commit()
    badges=[{'key':k,'name':BADGE_DEFS[k][0],'description':BADGE_DEFS[k][1],'icon':BADGE_DEFS[k][2]} for k in sorted(keys) if k in BADGE_DEFS]
    return jsonify(streak=streak_days(u.id),daily_goal_minutes=setting.daily_goal_minutes,
      today_minutes=(daily_activity(u.id).seconds or 0)//60,weekly_minutes=sum(x.seconds or 0 for x in week)//60,
      lessons_completed=stat.lessons_completed or 0,learned_words=LearnedWord.query.filter_by(user_id=u.id).count(),
      badges=badges)

@app.get('/api/leaderboard')
def leaderboard():
    period=request.args.get('period','week'); today=datetime.now(timezone.utc).date()
    start=today-timedelta(days=today.weekday()) if period=='week' else today.replace(day=1)
    rows=(db.session.query(User.id,User.name,func.coalesce(func.sum(DailyActivity.xp_earned),0).label('xp'))
      .outerjoin(DailyActivity,(DailyActivity.user_id==User.id)&(DailyActivity.activity_date>=start))
      .filter(User.is_active.is_(True),User.role=='user').group_by(User.id,User.name)
      .order_by(db.text('xp DESC'),User.id.asc()).limit(100).all())
    return jsonify(period=period,start=start.isoformat(),items=[{'rank':i+1,'name':r.name,'xp':int(r.xp or 0)} for i,r in enumerate(rows)])

LESSON_TOPICS=['Chào hỏi','Gia đình','Hằng ngày','Trường học','Ăn uống','Mua sắm','Du lịch','Công việc','Sức khỏe','Công nghệ','Thiên nhiên','Ôn tập tổng hợp']

def valid_course(language, level):
    language=str(language or '').strip().lower()
    level=str(level or '').strip().upper().replace(' ','')
    return language, level, language in VALID_LEVELS and level in VALID_LEVELS[language]

@app.get('/api/lessons')
@login_required
def lessons_list():
    u=current_user(); lang,level,ok=valid_course(request.args.get('language','english'),request.args.get('level','A1'))
    if not ok:return jsonify(error='Ngôn ngữ hoặc cấp độ không hợp lệ.'),400
    total=Word.query.filter_by(language=lang,level=level).count(); per=max(5,(total+11)//12 if total else 10)
    progress={x.lesson_number:x for x in LessonProgress.query.filter_by(user_id=u.id,language=lang,level=level).all()}
    items=[]
    for n in range(1,13):
        pr=progress.get(n); unlocked=n==1 or bool(progress.get(n-1) and progress[n-1].completed)
        items.append({'number':n,'title':LESSON_TOPICS[n-1],'word_count':min(per,max(0,total-(n-1)*per)),
          'completed':bool(pr and pr.completed),'best_score':int(pr.best_score if pr else 0),'unlocked':unlocked})
    return jsonify(language=lang,level=level,total_words=total,items=items)

@app.get('/api/lessons/<int:number>')
@login_required
def lesson_detail(number):
    if number<1 or number>12:return jsonify(error='Bài học không hợp lệ'),404
    u=current_user(); lang,level,ok=valid_course(request.args.get('language','english'),request.args.get('level','A1'))
    if not ok:return jsonify(error='Ngôn ngữ hoặc cấp độ không hợp lệ.'),400
    prior=LessonProgress.query.filter_by(user_id=u.id,language=lang,level=level,lesson_number=number-1,completed=True).first()
    if number>1 and not prior:return jsonify(error='Hãy hoàn thành bài trước để mở khóa.'),403
    total=Word.query.filter_by(language=lang,level=level).count(); per=max(5,(total+11)//12 if total else 10)
    words=Word.query.filter_by(language=lang,level=level).order_by(Word.id.asc()).offset((number-1)*per).limit(per).all()
    return jsonify(number=number,title=LESSON_TOPICS[number-1],items=[word_json(x) for x in words])

@app.post('/api/lessons/<int:number>/complete')
@login_required
@limited('lesson-complete',30,60)
def lesson_complete(number):
    if number<1 or number>12:return jsonify(error='Bài học không hợp lệ'),404
    u=current_user(); d=request.get_json(silent=True) or {}; lang,level,ok=valid_course(d.get('language','english'),d.get('level','A1'))
    if not ok:return jsonify(error='Ngôn ngữ hoặc cấp độ không hợp lệ.'),400
    
    try: score=max(0,min(100,int(d.get('score',0) or 0)))
    except (TypeError,ValueError): return jsonify(error='Điểm số không hợp lệ.'),400
    if number>1 and not LessonProgress.query.filter_by(user_id=u.id,language=lang,level=level,lesson_number=number-1,completed=True).first():
        return jsonify(error='Bài học này chưa được mở khóa.'),403
    row=LessonProgress.query.filter_by(user_id=u.id,language=lang,level=level,lesson_number=number).first()
    if not row: row=LessonProgress(user_id=u.id,language=lang,level=level,lesson_number=number); db.session.add(row)
    first=not bool(row.completed)
    row.attempts=int(row.attempts or 0)+1
    row.best_score=max(int(row.best_score or 0),score)
    row.completed=bool(score>=60 or row.completed)
    row.updated_at=datetime.now(timezone.utc)
    earned=20 if first and row.completed else (5 if score>=80 else 0)
    if earned: u.xp+=earned; record_activity(u.id,xp=earned)
    if first and row.completed: register_completed_lesson(u.id)
    audit('lesson_complete',f'{lang}/{level}/{number}; score={score}; xp={earned}'); sync_badges(u); db.session.commit()
    return jsonify(ok=True,completed=row.completed,best_score=row.best_score,earned_xp=earned,xp=u.xp)

@app.patch('/api/profile')
@login_required
def update_profile():
    u=current_user(); d=request.get_json(silent=True) or {}; setting=profile_setting(u.id)
    if 'name' in d:
        name=str(d.get('name','')).strip()[:100]
        if len(name)<2:return jsonify(error='Tên cần ít nhất 2 ký tự.'),400
        u.name=name
    if 'daily_goal_minutes' in d: setting.daily_goal_minutes=max(5,min(180,int(d.get('daily_goal_minutes',10))))
    if d.get('preferred_language') in ('english','chinese'): setting.preferred_language=d['preferred_language']
    audit('profile_update','user updated profile'); db.session.commit(); return jsonify(ok=True,user=user_json(u))

@app.get('/api/profile/export.json')
@login_required
def export_profile():
    u=current_user(); learned=db.session.query(LearnedWord,Word).join(Word,Word.id==LearnedWord.word_id).filter(LearnedWord.user_id==u.id).all()
    data={'exported_at':datetime.now(timezone.utc).isoformat(),'user':user_json(u),'study':study_stats_json(study_stat(u.id)),
      'learned_words':[learned_json(a,b) for a,b in learned],'lessons':[{'language':x.language,'level':x.level,'lesson':x.lesson_number,'score':x.best_score,'completed':x.completed} for x in LessonProgress.query.filter_by(user_id=u.id).all()]}
    return app.response_class(json.dumps(data,ensure_ascii=False,indent=2),mimetype='application/json',headers={'Content-Disposition':'attachment; filename=lingoplay-my-data.json'})

@app.get('/api/admin/backup.json')
@admin_required
def admin_backup():
    data={'created_at':datetime.now(timezone.utc).isoformat(),
      'users':[user_json(x) for x in User.query.all()],
      'words':[word_json(x) for x in Word.query.all()],
      'phrases':[{'language':x.language,'level':x.level,'phrase':x.phrase,'meaning':x.meaning} for x in Phrase.query.all()],
      'learned':[{'user_id':x.user_id,'word_id':x.word_id,'strength':x.strength,'correct':x.correct_count,'wrong':x.wrong_count} for x in LearnedWord.query.all()],
      'activities':[{'user_id':x.user_id,'date':x.activity_date.isoformat(),'seconds':x.seconds,'lessons':x.lessons,'xp':x.xp_earned} for x in DailyActivity.query.all()]}
    audit('admin_backup','json backup downloaded'); db.session.commit()
    return app.response_class(json.dumps(data,ensure_ascii=False,indent=2),mimetype='application/json',headers={'Content-Disposition':'attachment; filename=lingoplay-backup.json'})

@app.get('/api/admin/audit')
@admin_required
def admin_audit():
    rows=AuditLog.query.order_by(AuditLog.id.desc()).limit(200).all()
    return jsonify(items=[{'action':x.action,'detail':x.detail,'user_id':x.user_id,'created_at':x.created_at.isoformat()} for x in rows])

@app.errorhandler(404)
def not_found(err):
    if request.path.startswith('/api/'):return jsonify(error='Không tìm thấy API'),404
    return send_from_directory(PUBLIC_DIR,'lingoplay-home.html'),404

@app.errorhandler(500)
def server_error(err):
    db.session.rollback(); app.logger.exception('Unhandled server error')
    if request.path.startswith('/api/'):return jsonify(error='Máy chủ gặp lỗi tạm thời. Vui lòng thử lại.'),500
    return send_from_directory(PUBLIC_DIR,'lingoplay-home.html'),500

@app.get('/api/admin/stats')
@admin_required
def stats():
    today=datetime.now(timezone.utc).date()
    total_lessons=int(db.session.query(func.coalesce(func.sum(StudyStat.lessons_completed),0)).scalar() or 0)
    return jsonify(users=User.query.count(),words=Word.query.count(),phrases=Phrase.query.count(),active_users=User.query.filter_by(is_active=True).count(),today_active=DailyActivity.query.filter_by(activity_date=today).count(),lessons=total_lessons,audit_logs=AuditLog.query.count())
@app.get('/api/admin/users')
@admin_required
def admin_users():
    q=str(request.args.get('q','')).strip()[:100]
    role=str(request.args.get('role','all')).strip()
    status=str(request.args.get('status','all')).strip()
    query=User.query
    if q:
        like=f'%{q}%'
        query=query.filter(or_(User.name.ilike(like),User.email.ilike(like)))
    if role in ('user','admin'):
        query=query.filter(User.role==role)
    if status=='active':
        query=query.filter(User.is_active.is_(True))
    elif status=='locked':
        query=query.filter(User.is_active.is_(False))
    items=query.order_by(User.id.desc()).limit(500).all()
    return jsonify(items=[user_json(x) for x in items],total=len(items))

@app.post('/api/admin/users')
@admin_required
def admin_create_user():
    d=request.get_json(silent=True) or {}
    name=str(d.get('name','')).strip()[:100]
    email=str(d.get('email','')).strip().lower()[:255]
    password=str(d.get('password',''))
    role=str(d.get('role','user'))
    if not name or not email or '@' not in email:
        return jsonify(error='Tên hoặc email không hợp lệ'),400
    if User.query.filter(func.lower(User.email)==email).first():
        return jsonify(error='Email đã tồn tại'),409
    if not password_is_strong(password):
        return jsonify(error='Mật khẩu cần ít nhất 10 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.'),400
    if role not in ('user','admin'): role='user'
    u=User(name=name,email=email,password_hash=generate_password_hash(password),role=role,is_active=True,xp=0)
    db.session.add(u); db.session.flush(); security_state(u.id)
    audit('admin_create_user',f'user={u.id}; role={role}'); db.session.commit()
    return jsonify(ok=True,user=user_json(u)),201
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
    actor=current_user(); u=db.session.get(User,uid)
    if not u:return jsonify(error='Không tìm thấy người dùng'),404
    d=request.get_json(silent=True) or {}
    if 'is_active' in d:
        desired=bool(d['is_active'])
        if uid==actor.id and not desired:
            return jsonify(error='Bạn không thể tự khóa tài khoản quản trị đang dùng.'),400
        u.is_active=desired
        if not desired:
            state=security_state(u.id); state.session_version+=1
    requested_role=d.get('role')
    if requested_role in ('user','admin') and requested_role!=u.role:
        if uid==actor.id:
            return jsonify(error='Bạn không thể tự thay đổi quyền của chính mình.'),400
        if u.role=='admin' and requested_role=='user' and User.query.filter_by(role='admin',is_active=True).count()<=1:
            return jsonify(error='Hệ thống phải còn ít nhất một quản trị viên đang hoạt động.'),400
        u.role=requested_role
        security_state(u.id).session_version+=1
    audit('admin_update_user',f'user={uid}; active={u.is_active}; role={u.role}')
    db.session.commit(); return jsonify(ok=True,user=user_json(u))

@app.post('/api/admin/users/<int:uid>/reset-password')
@admin_required
def admin_reset_user_password(uid):
    u=db.session.get(User,uid)
    if not u:return jsonify(error='Không tìm thấy người dùng'),404
    d=request.get_json(silent=True) or {}
    new_password=str(d.get('new_password',''))
    if not password_is_strong(new_password):
        return jsonify(error='Mật khẩu mới cần ít nhất 10 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt.'),400
    u.password_hash=generate_password_hash(new_password)
    state=security_state(u.id); state.session_version+=1; state.failed_logins=0; state.locked_until=None; state.last_password_change=datetime.now(timezone.utc)
    PasswordReset.query.filter_by(user_id=u.id,used=False).update({'used':True})
    audit('admin_reset_password',f'user={uid}')
    db.session.commit()
    return jsonify(ok=True,message='Đã đặt mật khẩu mới và đăng xuất tài khoản khỏi các thiết bị cũ.')

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
    for user in User.query.all(): security_state(user.id); profile_setting(user.id)
    GameChallenge.query.filter(GameChallenge.expires_at < datetime.now(timezone.utc)-timedelta(days=1)).delete(synchronize_session=False)
    ReviewChallenge.query.filter(ReviewChallenge.expires_at < datetime.now(timezone.utc)-timedelta(days=1)).delete(synchronize_session=False)
    db.session.commit()

with app.app_context(): seed()
if __name__=='__main__': app.run(host='127.0.0.1',port=int(os.getenv('PORT','3000')),debug=False)
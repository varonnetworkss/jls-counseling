/* ============================================================================
   1. 데이터 레이어 (localStorage, 서버 이전 용이한 정규화 구조)
   ============================================================================ */
const STAGES = ['HC1','HC2','MC1','MC2','MC3'];

/* ----- 학기 자동 계산 -----
   월 기준: 12·1·2=겨울, 3·4·5=봄, 6·7·8=여름, 9·10·11=가을
   12월은 다음 해 겨울학기로 귀속 (예: 2026-12 → "2027년 겨울학기") */
const SEASONS = [
  { key:'winter', label:'겨울', months:[12,1,2] },
  { key:'spring', label:'봄',   months:[3,4,5] },
  { key:'summer', label:'여름', months:[6,7,8] },
  { key:'fall',   label:'가을', months:[9,10,11] },
];
function seasonOfMonth(m){ return SEASONS.find(s=> s.months.includes(m)); }
/* 특정 날짜(Date)가 속한 학기 → {id, name, year, key} */
function semesterOfDate(d){
  let year = d.getFullYear();
  const month = d.getMonth()+1;
  const season = seasonOfMonth(month);
  if(season.key==='winter' && month===12) year += 1; // 12월은 다음 해 겨울
  return { id:`sem_${year}_${season.key}`, name:`${year}년 ${season.label}학기`, year, key:season.key };
}
function currentSemester(){ return semesterOfDate(new Date()); }
/* 현재 학기에서 n학기 전 */
function semesterBack(base, n){
  const order = ['spring','summer','fall','winter']; // 봄→여름→가을→겨울
  let year = base.year, idx = order.indexOf(base.key);
  for(let i=0;i<n;i++){ idx-=1; if(idx<0){ idx=order.length-1; year-=1; } }
  const key = order[idx];
  const label = SEASONS.find(s=>s.key===key).label;
  return { id:`sem_${year}_${key}`, name:`${year}년 ${label}학기`, year, key };
}
/* db.semesters를 현재 학기 기준으로 최신화 (현재 + 직전 3학기 + 데이터 있는 과거학기 유지) */
function ensureSemesters(){
  if(!db.semesters) db.semesters = [];
  const cur = currentSemester();
  // 현재 학기는 항상 포함 (없으면 추가)
  if(!db.semesters.some(s=>s.id===cur.id)){
    db.semesters.push({ id:cur.id, name:cur.name });
  } else {
    const ex = db.semesters.find(s=>s.id===cur.id);
    if(ex.name!==cur.name) ex.name = cur.name;
  }
  // 실제 데이터(학생 레코드/상담)가 있는 과거 학기만 유지, 데이터 없는 과거학기는 목록에서 제거
  const usedSemIds = new Set([
    cur.id,
    ...((db.semesterRecords||[]).map(r=>r.semesterId)),
    ...((db.counselingHistories||[]).map(c=>c.semesterId)),
  ]);
  db.semesters = db.semesters.filter(s=> usedSemIds.has(s.id));
  // 최신순 정렬
  const rank = id=>{
    const m = String(id).match(/sem_(\d+)_(\w+)/);
    if(!m) return 0;
    const order = {spring:0,summer:1,fall:2,winter:3};
    return parseInt(m[1],10)*10 + (order[m[2]]||0);
  };
  db.semesters.sort((a,b)=> rank(b.id)-rank(a.id));
}

/* ============================================================================
   ★ Supabase 연동 — 여러 컴퓨터에서 같은 데이터 공유
   ============================================================================
   동작 방식:
   - 앱 시작 시 Supabase에서 전체 데이터를 읽어 메모리(db)에 적재
   - 화면 렌더링은 기존처럼 메모리 db를 보고 그림 (렌더 코드 그대로 유지)
   - saveDB() 호출 시, 직전 스냅샷과 비교해 바뀐 행만 서버에 반영(upsert/삭제)
   ============================================================================ */
const SUPABASE_URL = 'https://hplndiuoohantbalixwu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xO8KB46SzMx8KeuEE-OVSw_su22mv9X';
let sb = null;              // supabase client
let dbSnapshot = null;      // 마지막으로 서버와 동기화된 상태(diff 비교용)

/* JS 컬렉션명 ↔ DB 테이블명 ↔ 행 매핑 정의 */
const TABLES = [
  { key:'branches',           table:'branches',             toRow:b=>({id:b.id,name:b.name}),
    fromRow:r=>({id:r.id,name:r.name}) },
  { key:'users',              table:'users',                toRow:u=>({id:u.id,username:u.username,password:u.password,role:u.role,branch_id:u.branchId}),
    fromRow:r=>({id:r.id,username:r.username,password:r.password,role:r.role,branchId:r.branch_id}) },
  { key:'semesters',          table:'semesters',            toRow:s=>({id:s.id,name:s.name}),
    fromRow:r=>({id:r.id,name:r.name}) },
  { key:'students',           table:'students',             toRow:s=>({id:s.id,code:s.code,name:s.name,school:s.school,grade:s.grade}),
    fromRow:r=>({id:r.id,code:r.code,name:r.name,school:r.school,grade:r.grade}) },
  { key:'semesterRecords',    table:'semester_records',     toRow:r=>({id:r.id,student_id:r.studentId,branch_id:r.branchId,semester_id:r.semesterId,class_name:r.className,class_label:r.classLabel,teacher:r.teacher,note:r.note,target_type:r.targetType,status:r.status,origin:r.origin,enroll_date:r.enrollDate}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,className:r.class_name,classLabel:r.class_label,teacher:r.teacher,note:r.note,targetType:r.target_type,status:r.status,origin:r.origin,enrollDate:r.enroll_date}) },
  { key:'counselingHistories',table:'counseling_histories', toRow:c=>({id:c.id,student_id:c.studentId,branch_id:c.branchId,semester_id:c.semesterId,date:c.date,type:c.type,content:c.content,counselor:c.counselor,batch_id:c.batchId,mistag:!!c.mistag}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,date:r.date,type:r.type,content:r.content,counselor:r.counselor,batchId:r.batch_id,mistag:!!r.mistag}) },
  { key:'studentMovements',   table:'student_movements',    toRow:m=>({id:m.id,student_id:m.studentId,branch_id:m.branchId,semester_id:m.semesterId,type:m.type,date:m.date,memo:m.memo}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,type:r.type,date:r.date,memo:r.memo}) },
  { key:'uploadBatches',      table:'upload_batches',       toRow:b=>({id:b.id,branch_id:b.branchId,semester_id:b.semesterId,kind:b.kind,file_name:b.fileName,uploaded_at:b.uploadedAt,added:b.added,dup:b.dup,skip:b.skip}),
    fromRow:r=>({id:r.id,branchId:r.branch_id,semesterId:r.semester_id,kind:r.kind,fileName:r.file_name,uploadedAt:r.uploaded_at,added:r.added,dup:r.dup,skip:r.skip}) },
];

function blankDB(){
  return { users:[], branches:[], semesters:[], students:[],
           semesterRecords:[], counselingHistories:[], studentMovements:[],
           uploadBatches:[] };
}
let db = null;

/* Supabase 클라이언트 초기화 */
function initSupabase(){
  if(sb) return sb;
  if(typeof supabase==='undefined' || !supabase.createClient){
    throw new Error('Supabase 라이브러리가 로드되지 않았습니다 (인터넷 연결 확인).');
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

/* 서버에서 전체 데이터 읽기 → 메모리 db */
async function loadDB(){
  initSupabase();
  db = blankDB();
  for(const t of TABLES){
    const { data, error } = await sb.from(t.table).select('*');
    if(error){ console.error('load fail', t.table, error); throw error; }
    db[t.key] = (data||[]).map(t.fromRow);
  }
  // 학기 자동 보강 (현재+직전 학기). 새로 추가된 학기는 서버에도 저장.
  ensureSemesters();
  dbSnapshot = JSON.parse(JSON.stringify(db));  // 기준 스냅샷
  await saveDB(); // ensureSemesters로 늘어난 학기 등 반영
}

/* 메모리 db를 서버에 동기화 — 직전 스냅샷과 비교해 바뀐 행만 upsert + 삭제된 행 delete */
async function saveDB(){
  if(!sb){ try{ initSupabase(); }catch(e){ console.error(e); return; } }
  try{
    for(const t of TABLES){
      const cur = db[t.key] || [];
      const prev = (dbSnapshot && dbSnapshot[t.key]) || [];
      const curById = new Map(cur.map(x=>[x.id,x]));
      const prevById = new Map(prev.map(x=>[x.id,x]));
      // upsert 대상: 새로 생겼거나 내용이 바뀐 행
      const ups = [];
      for(const [id,row] of curById){
        const before = prevById.get(id);
        if(!before || JSON.stringify(before)!==JSON.stringify(row)) ups.push(t.toRow(row));
      }
      // 삭제 대상: 이전엔 있었는데 지금 없는 행
      const delIds = [];
      for(const id of prevById.keys()){ if(!curById.has(id)) delIds.push(id); }
      if(ups.length){
        const { error } = await sb.from(t.table).upsert(ups);
        if(error){ console.error('upsert fail', t.table, error); }
      }
      if(delIds.length){
        const { error } = await sb.from(t.table).delete().in('id', delIds);
        if(error){ console.error('delete fail', t.table, error); }
      }
    }
    dbSnapshot = JSON.parse(JSON.stringify(db));  // 동기화 완료 → 스냅샷 갱신
  }catch(e){ console.error('saveDB error', e); toast('서버 저장 중 오류가 발생했습니다','err'); }
}

/* 전체 초기화 — 학생/상담/명단/이동/배치 비우고 분원·계정·학기는 유지 */
async function resetDB(){
  // 데이터성 테이블만 비움 (branches/users/semesters 유지)
  for(const key of ['students','semesterRecords','counselingHistories','studentMovements','uploadBatches']){
    db[key] = [];
  }
  ensureSemesters();
  await saveDB();
}
function uid(p){ return p+'_'+Math.random().toString(36).slice(2,9); }

/* ----- 세션 ----- */
const SESSION_KEY = 'jls_session_v1';
let session = null;
function loadSession(){ try{ session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); }catch(e){ session=null; } }
function setSession(s){ session = s; sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession(){ session=null; sessionStorage.removeItem(SESSION_KEY); }

/* ============================================================================
   2. (시드 함수 제거됨 — 분원·계정·학기는 Supabase에서 관리)
   ============================================================================ */


/* ============================================================================
   3. 조회 / 계산 로직
   ============================================================================ */
function getBranch(id){ return db.branches.find(b=>b.id===id); }
function getStudent(id){ return db.students.find(s=>s.id===id); }
function currentSemId(){ return state.semId; }

/* 한 학기 한 분원의 active 학기레코드 */
function recordsOf(branchId, semId){
  return db.semesterRecords.filter(r=>r.branchId===branchId && r.semesterId===semId);
}
function activeRecordsOf(branchId, semId){
  return recordsOf(branchId,semId).filter(r=>r.status==='active');
}

/* 학기 시작 월 (학기명에서 계절 추출) → [1번째달, 2번째달, 3번째달] */
function semesterMonths(semId){
  const sem = db.semesters.find(s=>s.id===semId);
  const name = sem ? sem.name : '';
  if(name.includes('겨울')) return [12,1,2];
  if(name.includes('봄'))   return [3,4,5];
  if(name.includes('여름')) return [6,7,8];
  if(name.includes('가을')) return [9,10,11];
  return [1,2,3];
}
/* 상담 회차(MC1~3)와 실제 상담 날짜를 비교해 어느 학기 상담인지 판정.
   - HC1/HC2: 월 제한 없음 → 'ok'
   - 상담월 >= 회차정상월(정상이거나 늦게함)        → 'ok'      (현재학기 인정)
   - 정상월이 상담월보다 2달 이상 뒤(너무 이름)     → 'prev'    (이전학기 → 제외)
   - 정상월이 상담월보다 딱 1달 뒤(애매하게 이름)   → 'mistag'  (오기재 의심 → 제외+메모) */
function stageTimingCheck(type, dateStr, semId){
  if(type==='HC1' || type==='HC2') return 'ok';
  const months = semesterMonths(semId);            // 예: [6,7,8]
  const stageIdx = { MC1:0, MC2:1, MC3:2 }[type];  // 회차의 정상 '몇 번째 달'
  if(stageIdx==null) return 'ok';
  const m = String(dateStr||'').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(!m) return 'ok';                              // 날짜 파싱 불가 → 인정
  const cMonth = parseInt(m[2],10);
  const slot = months.indexOf(cMonth);             // 상담월이 이 학기의 몇 번째 달인지
  if(slot===-1) return 'prev';                     // 학기 3개월에 없음 → 이전학기
  const diff = stageIdx - slot;                    // 회차정상위치 - 실제상담위치
  if(diff <= 0) return 'ok';
  if(diff === 1) return 'mistag';
  return 'prev';
}
/* 입학일(enrollDate)에서 월 추출. 없으면 null(=학기초부터 다닌 학생) */
function enrollMonth(rec){
  if(!rec.enrollDate) return null;
  const m = String(rec.enrollDate).match(/\d{4}-(\d{1,2})/) || String(rec.enrollDate).match(/\d{4}\.(\d{1,2})/);
  return m ? parseInt(m[1],10) : null;
}
/* 학생이 특정 단계 상담 대상인지 — 입학월 기준
   HC1/HC2: 신규·복귀생이면 입학월 상관없이 대상
   MC1/2/3: 입학월 이후의 MC만 대상 (예: 7월 입학 → MC1 제외, MC2·MC3 대상) */
function isTarget(rec, stage, semId){
  if(stage==='HC1'||stage==='HC2') return rec.targetType==='HCMC';
  const months = semesterMonths(semId || (typeof state!=='undefined'?state.semId:null));
  const mcMonth = { MC1:months[0], MC2:months[1], MC3:months[2] }[stage];
  const em = enrollMonth(rec);
  if(em==null) return true;     // 입학일 없으면 학기초부터 → 전부 대상
  return em <= mcMonth;         // 입학월이 해당 MC 월보다 늦으면 제외
}
/* 학생이 특정 단계 완료했는지 */
function isDone(studentId, branchId, semId, stage){
  return db.counselingHistories.some(c=>
    c.studentId===studentId && c.branchId===branchId &&
    c.semesterId===semId && c.type===stage && !c.mistag);  // 오기재 의심은 완료로 치지 않음
}
/* 학생의 상담 이력(특정 단계) */
function historiesOf(studentId, branchId, semId, stage){
  return db.counselingHistories.filter(c=>
    c.studentId===studentId && c.branchId===branchId &&
    c.semesterId===semId && (!stage || c.type===stage))
    .sort((a,b)=> a.date.localeCompare(b.date));
}

/*
  상담률 계산 — [전체 대상 건수 대비 완료 건수] 방식으로 통일.
  recs: active 학기레코드 배열.
  반환: { stages:{HC1:{target,done,rate}...}, totalTarget, totalDone, totalRate, incompleteStudents }
*/
function calcRates(recs, branchId, semId){
  const out = { stages:{}, totalTarget:0, totalDone:0, totalRate:0, incompleteStudents:0 };
  STAGES.forEach(s=> out.stages[s] = {target:0, done:0, rate:0});
  const incompleteSet = new Set();
  recs.forEach(rec=>{
    STAGES.forEach(stg=>{
      if(!isTarget(rec, stg, semId)) return;
      out.stages[stg].target++;
      out.totalTarget++;
      if(isDone(rec.studentId, branchId, semId, stg)){
        out.stages[stg].done++; out.totalDone++;
      } else {
        incompleteSet.add(rec.studentId);
      }
    });
  });
  STAGES.forEach(s=>{
    const st = out.stages[s];
    st.rate = st.target ? Math.round(st.done/st.target*100) : null;
  });
  out.totalRate = out.totalTarget ? Math.round(out.totalDone/out.totalTarget*100) : 0;
  out.incompleteStudents = incompleteSet.size;
  return out;
}

/* 인원 통계 — 학기초/신규/퇴원/현재/순증감
   학기초 인원 = 전체 명단 - 신규생 (학기 시작 시점 인원)
   현재 재원생 = status가 active 인 인원
   순증감 = 신규 - 퇴원 */
function headcountClean(branchId, semId){
  const recs = recordsOf(branchId, semId);
  const total = recs.length;
  const newCnt = recs.filter(r=>r.origin==='new').length;
  const withdraw = recs.filter(r=>r.status==='withdraw').length;
  const active = recs.filter(r=>r.status==='active').length;
  const startCount = total - newCnt;       // 학기초 인원 = 전체 - 신규
  return { start:startCount, newCnt, withdraw, active, net:newCnt - withdraw };
}

/* 담임별 집계 */
function teachersOf(branchId, semId){
  const recs = activeRecordsOf(branchId, semId);
  const allRecs = recordsOf(branchId, semId); // 퇴원 포함 전체
  const map = new Map();
  recs.forEach(r=>{
    if(!map.has(r.teacher)) map.set(r.teacher, []);
    map.get(r.teacher).push(r);
  });
  return [...map.entries()].map(([teacher, trecs])=>{
    const classes = new Set(trecs.map(r=>r.className));
    const rates = calcRates(trecs, branchId, semId);
    // 이 담임의 퇴원생 수 (status=withdraw, 같은 담임)
    const withdrawCnt = allRecs.filter(r=>r.teacher===teacher && r.status==='withdraw').length;
    const newCnt = trecs.filter(r=>r.origin==='new').length;
    // 퇴원율 = 퇴원 / (현재 재원 + 퇴원) — 한때 맡았던 전체 대비
    const base = trecs.length + withdrawCnt;
    const withdrawRate = base>0 ? Math.round(withdrawCnt/base*100) : 0;
    return { teacher, recs:trecs, studentCount:trecs.length,
             classCount:classes.size, rates,
             withdrawCnt, newCnt, withdrawRate };
  }).sort((a,b)=> a.teacher.localeCompare(b.teacher,'ko'));
}

/* 전 분원 통합 담임 목록 — 같은 이름이라도 분원이 다르면 별개로 취급(분원명 병기) */
function allTeachers(semId){
  const out = [];
  db.branches.forEach(b=>{
    teachersOf(b.id, semId).forEach(t=>{
      out.push({ ...t, branchId:b.id, branchName:b.name });
    });
  });
  return out;
}

/* 한 담임의 반별 집계 */
function classesOf(branchId, semId, teacher){
  const recs = activeRecordsOf(branchId, semId).filter(r=>r.teacher===teacher);
  const map = new Map();
  recs.forEach(r=>{ if(!map.has(r.className)) map.set(r.className,[]); map.get(r.className).push(r); });
  return [...map.entries()].map(([className, crecs])=>{
    const rates = calcRates(crecs, branchId, semId);
    const label = crecs[0].classLabel || classLabel(className) || className;
    return { className, label, recs:crecs, studentCount:crecs.length, rates };
  }).sort((a,b)=> a.label.localeCompare(b.label,'ko'));
}
/* ============================================================================
   4. 앱 상태 & 라우터
   ============================================================================ */
const state = { semId:null, route:null, branchSort:'active', teacherSort:'rate_desc', classSort:'rate_desc', allTeacherSort:'wrate_desc' };

const el = id => document.getElementById(id);
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(n){ return (n==null?'–':n.toLocaleString()); }
function deltaHtml(n){
  const cls = n>0?'pos':n<0?'neg':'zero';
  const sign = n>0?'+':'';
  return `<span class="delta ${cls} num">${sign}${n}</span>`;
}
function rateColor(r){
  if(r==null) return 'var(--line-2)';
  if(r>=80) return 'var(--pos)';
  if(r>=50) return 'var(--brand)';
  if(r>=30) return 'var(--warn)';
  return 'var(--neg)';
}
function toast(msg, kind){
  const t = el('toast'); t.textContent = msg; t.className = 'show'+(kind?' '+kind:'');
  clearTimeout(t._tm); t._tm = setTimeout(()=> t.className='', 2400);
}

/* 해시 라우트: #/admin , #/admin/branch/:bid , #/branch ,
   #/branch/teacher/:t , #/branch/class/:t/:c , #/data , #/accounts */
function parseRoute(){
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h ? h.split('/') : [];
  return { parts };
}
function go(path){ location.hash = '#/'+path; }
window.addEventListener('hashchange', render);

/* ============================================================================
   5. 로그인 / 로그아웃
   ============================================================================ */
function doLogin(){
  const u = el('loginId').value.trim();
  const p = el('loginPw').value;
  const user = db.users.find(x=>x.username===u && x.password===p);
  if(!user){ el('loginErr').textContent = '아이디 또는 비밀번호가 올바르지 않습니다.'; return; }
  setSession({ userId:user.id, username:user.username, role:user.role, branchId:user.branchId });
  el('loginErr').textContent='';
  el('loginPw').value='';
  enterApp();
}
function logout(){ clearSession(); location.hash=''; showLogin(); }

function showLogin(){ el('appView').style.display='none'; el('loginView').style.display='flex'; }
function enterApp(){
  el('loginView').style.display='none';
  el('appView').style.display='block';
  // 오늘 날짜 기준 현재 학기를 기본 선택 (없으면 목록 첫 번째)
  const cur = currentSemester();
  state.semId = db.semesters.some(s=>s.id===cur.id) ? cur.id : (db.semesters[0] ? db.semesters[0].id : null);
  buildShell();
  if(!location.hash || location.hash==='#'){
    location.hash = session.role==='admin' ? '#/admin' : '#/branch';
  } else { render(); }
}

/* ============================================================================
   6. 앱 셸 (사이드바, 학기 선택)
   ============================================================================ */
function buildShell(){
  const isAdmin = session.role==='admin';
  const branch = isAdmin ? null : getBranch(session.branchId);
  el('sbScope').textContent = isAdmin ? '통합 관리자' : (branch?branch.name:'분원');
  el('sbAvatar').textContent = (session.username[0]||'U').toUpperCase();
  el('sbUserName').textContent = isAdmin ? '관리자' : (branch?branch.name:session.username);
  el('sbUserRole').textContent = session.username;

  // 학기 선택
  const sel = el('semSelect');
  sel.innerHTML = db.semesters.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.value = state.semId;
  sel.onchange = ()=>{ state.semId = sel.value; render(); };

  // 네비
  const nav = el('sbNav');
  const I = {
    dash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    data:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>',
    acct:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    stu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
  };
  if(isAdmin){
    nav.innerHTML = `
      <div class="sb-sect">관리</div>
      <div class="sb-item" data-nav="admin">${I.dash}<span>통합 대시보드</span></div>
      <div class="sb-item" data-nav="accounts">${I.acct}<span>분원 계정 관리</span></div>`;
  } else {
    nav.innerHTML = `
      <div class="sb-sect">분원</div>
      <div class="sb-item" data-nav="branch">${I.dash}<span>Dashboard</span></div>
      <div class="sb-item" data-nav="students">${I.stu}<span>학생관리</span></div>
      <div class="sb-item" data-nav="data">${I.data}<span>데이터관리</span></div>`;
  }
  nav.querySelectorAll('[data-nav]').forEach(it=>{
    it.onclick = ()=> go(it.dataset.nav);
  });
}
function setActiveNav(key){
  document.querySelectorAll('.sb-item').forEach(it=>{
    it.classList.toggle('active', it.dataset.nav===key);
  });
}
function crumbs(items){
  el('crumbs').innerHTML = items.map((it,i)=>{
    const last = i===items.length-1;
    const sep = i>0 ? '<span class="c-sep">›</span>' : '';
    if(last) return sep+`<span class="c-cur">${esc(it.label)}</span>`;
    return sep+`<span class="c-link" data-go="${it.go||''}">${esc(it.label)}</span>`;
  }).join('');
  el('crumbs').querySelectorAll('[data-go]').forEach(c=>{
    c.onclick = ()=>{ if(c.dataset.go) go(c.dataset.go); };
  });
}

/* ============================================================================
   7. 메인 라우팅 — 권한 가드 포함
   ============================================================================ */
function render(){
  if(!session){ showLogin(); return; }
  const { parts } = parseRoute();
  const root = parts[0] || (session.role==='admin'?'admin':'branch');

  // 권한 가드
  // admin은 branch/teacher, branch/class (담임·반 상세)는 볼 수 있으나
  // branch 대시보드/데이터관리는 불가. branch는 admin/accounts 불가.
  if(session.role==='admin'){
    if(root==='branch' && parts[1]!=='teacher' && parts[1]!=='class'){ go('admin'); return; }
    if(root==='data'||root==='students'){ go('admin'); return; }
  }
  if(session.role==='branch' && (root==='admin'||root==='accounts')){ go('branch'); return; }

  const c = el('content');
  if(root==='admin'){
    if(parts[1]==='branch' && parts[2]){ setActiveNav('admin'); renderAdminBranchDetail(parts[2]); }
    else { setActiveNav('admin'); renderAdminDashboard(); }
  } else if(root==='accounts'){ setActiveNav('accounts'); renderAccounts(); }
  else if(root==='branch'){
    if(parts[1]==='teacher' && parts[2]){ setActiveNav('branch'); renderTeacherDetail(decodeURIComponent(parts[2])); }
    else if(parts[1]==='class' && parts[2] && parts[3]){ setActiveNav('branch'); renderClassDetail(decodeURIComponent(parts[2]), decodeURIComponent(parts[3])); }
    else { setActiveNav('branch'); renderBranchDashboard(); }
  } else if(root==='data'){ setActiveNav('data'); renderDataManagement(); }
  else if(root==='students'){ setActiveNav('students'); renderStudentManagement(); }
  else { go(session.role==='admin'?'admin':'branch'); return; }
  el('content').scrollIntoView({block:'start'});
  window.scrollTo(0,0);
}
/* ============================================================================
   8. 공통 컴포넌트 헬퍼
   ============================================================================ */
function kpiCard(label, value, opts={}){
  const cls = opts.accent ? ' accent' : '';
  let v = opts.delta!=null ? deltaHtml(opts.delta) :
          `<span class="num">${esc(value)}</span>${opts.unit?`<small>${opts.unit}</small>`:''}`;
  return `<div class="kpi${cls}"><div class="kl">${esc(label)}</div><div class="kv">${v}</div></div>`;
}

/* 상담 5단계 막대 (카드 안) */
function stageBars(rates){
  return `<div class="stage-bars">`+ STAGES.map(s=>{
    const st = rates.stages[s];
    if(st.rate==null){
      return `<div class="stage na"><span class="sl">${s}</span>
        <div class="strack"></div><span class="sv">–</span></div>`;
    }
    return `<div class="stage"><span class="sl">${s}</span>
      <div class="strack"><div class="sfill" style="width:${st.rate}%;background:${rateColor(st.rate)}"></div></div>
      <span class="sv num">${st.rate}%</span></div>`;
  }).join('')+`</div>`;
}

/* 상담 5단계 패널 (상세 상단, 총계 포함) */
function ratePanel(rates){
  const cells = STAGES.map(s=>{
    const st = rates.stages[s];
    const v = st.rate==null ? '–' : st.rate+'%';
    const meta = st.target ? `${st.done}/${st.target}명` : '대상 없음';
    return `<div class="rate-cell">
      <div class="rcl">${s}</div>
      <div class="rcv num">${v}</div>
      <div class="rcm">${meta}</div>
      <div class="rctrack"><div class="rcfill" style="width:${st.rate||0}%;background:${rateColor(st.rate)}"></div></div>
    </div>`;
  }).join('');
  const tot = `<div class="rate-cell total">
      <div class="rcl">전체 상담률</div>
      <div class="rcv num">${rates.totalRate}%</div>
      <div class="rcm">${rates.totalDone}/${rates.totalTarget}건</div>
      <div class="rctrack"><div class="rcfill" style="width:${rates.totalRate}%;background:var(--brand)"></div></div>
    </div>`;
  return `<div class="rate-panel">${cells}${tot}</div>`;
}

function incompleteTag(n){
  if(n===0) return `<span class="incomplete-tag zero">미완료 0명</span>`;
  return `<span class="incomplete-tag">미완료 ${n}명</span>`;
}
const goArrow = `<span class="go">상세<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>`;
function backLink(label, target){
  return `<div class="back-link" onclick="go('${target}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>${esc(label)}</div>`;
}

/* ============================================================================
   9. 관리자 — 통합 대시보드
   ============================================================================ */
function renderAdminDashboard(){
  const semId = state.semId;
  crumbs([{label:'통합 대시보드'}]);

  // 전체 합산
  let tot = { start:0, newCnt:0, withdraw:0, active:0, net:0 };
  const cards = db.branches.map(b=>{
    const hc = headcountClean(b.id, semId);
    const rates = calcRates(activeRecordsOf(b.id, semId), b.id, semId);
    tot.start+=hc.start; tot.newCnt+=hc.newCnt; tot.withdraw+=hc.withdraw;
    tot.active+=hc.active; tot.net+=hc.net;
    // 분원 퇴원율 = 퇴원 / (재원+퇴원)
    const wbase = hc.active + hc.withdraw;
    const withdrawRate = wbase>0 ? Math.round(hc.withdraw/wbase*100) : 0;
    return { b, hc, rates, withdrawRate };
  });
  const totWbase = tot.active + tot.withdraw;
  const totWithdrawRate = totWbase>0 ? Math.round(tot.withdraw/totWbase*100) : 0;

  let html = `
    <div class="page-head">
      <h2>통합 대시보드</h2>
      <div class="sub">6개 분원 통합 현황 · ${esc(db.semesters.find(s=>s.id===semId).name)}</div>
    </div>
    <div class="kpi-row c5">
      ${kpiCard('전체 학기초 인원', tot.start, {unit:'명'})}
      ${kpiCard('전체 신규생', tot.newCnt, {unit:'명'})}
      ${kpiCard('전체 퇴원생', tot.withdraw, {unit:'명'})}
      ${kpiCard('전체 퇴원율', totWithdrawRate, {unit:'%'})}
      ${kpiCard('현 재원생', tot.active, {unit:'명', accent:true})}
    </div>
    <div class="sect-head">
      <h3>분원별 현황</h3>
      <div class="sort-bar">
        ${branchSortBtn('active','재원생순')}
        ${branchSortBtn('new','신규순')}
        ${branchSortBtn('withdraw','퇴원순')}
        ${branchSortBtn('wrate','퇴원율순')}
        ${branchSortBtn('rate','상담률순')}
      </div>
    </div>
    <div class="card-grid g3">`;

  // 정렬
  const sortKey = state.branchSort;
  const val = c => sortKey==='active' ? c.hc.active
            : sortKey==='new' ? c.hc.newCnt
            : sortKey==='withdraw' ? c.hc.withdraw
            : sortKey==='wrate' ? c.withdrawRate
            : c.rates.totalRate; // rate
  cards.sort((a,b)=> val(b)-val(a));
  // 상담률순일 때만 최고/최저 강조 (데이터 있는 카드 기준)
  const rated = cards.filter(c=> c.hc.active>0);
  const bestId = (sortKey==='rate' && rated.length) ? rated[0].b.id : null;
  const worstId = (sortKey==='rate' && rated.length>1) ? rated[rated.length-1].b.id : null;

  html += cards.map(({b,hc,rates,withdrawRate}, i)=>{
    const hasData = hc.active>0 || hc.start>0;
    const rank = i+1;
    const rankCls = rank===1?'r1':rank===2?'r2':rank===3?'r3':'';
    const cardCls = b.id===bestId?' best' : b.id===worstId?' worst' : '';
    const wrColor = withdrawRate>=15?'var(--neg)':withdrawRate>=8?'var(--warn)':'var(--ink-2)';
    return `<div class="card clickable${cardCls}" onclick="go('admin/branch/${b.id}')">
      <div class="rank-badge ${rankCls}">${rank}</div>
      <div class="card-top">
        <div>
          <div class="card-name">${esc(b.name)}
            ${b.id===bestId?'<span class="tag-best">최고</span>':b.id===worstId?'<span class="tag-worst">최저</span>':''}</div>
          <div class="card-sub">재원 ${hc.active}명 · 신규 <b style="color:var(--brand)">${hc.newCnt}</b> · 퇴원 <b style="color:${wrColor}">${hc.withdraw}</b> <span style="color:${wrColor}">(${withdrawRate}%)</span></div>
        </div>
        <div class="card-rate">
          <div class="r num" style="color:${hasData?rateColor(rates.totalRate):'var(--ink-3)'}">${hasData?rates.totalRate+'%':'–'}</div>
          <div class="rl">전체 상담률</div>
        </div>
      </div>
      <div class="mini-stats">
        <div class="mini-stat"><div class="v num">${hc.start}</div><div class="l">학기초</div></div>
        <div class="mini-stat"><div class="v num">${hc.active}</div><div class="l">현재 재원</div></div>
        <div class="mini-stat"><div class="v num">${hc.net>0?'+':''}${hc.net}</div><div class="l">순증감</div></div>
      </div>
      ${hasData ? stageBars(rates) : `<div style="color:var(--ink-3);font-size:12.5px;padding:8px 0">아직 업로드된 데이터가 없습니다</div>`}
      <div class="card-foot">
        ${hasData?incompleteTag(rates.incompleteStudents):'<span></span>'}
        ${goArrow}
      </div>
    </div>`;
  }).join('');
  html += `</div>`;

  // ===== 전 분원 통합 담임 순위 =====
  const allT = allTeachers(semId);
  html += `
    <div class="sect-head">
      <h3>전 분원 담임 순위</h3>
      <div class="sort-bar">
        ${allTeacherSortBtn('rate_desc','상담률순')}
        ${allTeacherSortBtn('wrate_desc','퇴원율 높은순')}
        ${allTeacherSortBtn('withdraw_desc','퇴원수 많은순')}
        ${allTeacherSortBtn('students_desc','학생수순')}
      </div>
    </div>`;
  if(allT.length===0){
    html += emptyState('아직 데이터가 없습니다','각 분원이 명단을 업로드하면 전체 담임 순위가 표시됩니다.');
  } else {
    const k = state.allTeacherSort;
    if(k==='wrate_desc') allT.sort((a,b)=> b.withdrawRate-a.withdrawRate || b.withdrawCnt-a.withdrawCnt);
    else if(k==='withdraw_desc') allT.sort((a,b)=> b.withdrawCnt-a.withdrawCnt);
    else if(k==='students_desc') allT.sort((a,b)=> b.studentCount-a.studentCount);
    else allT.sort((a,b)=> b.rates.totalRate-a.rates.totalRate);
    html += `<div class="table-wrap"><div class="table-scroll">
      <table class="rank-table">
        <thead><tr>
          <th class="cc">순위</th><th>담임</th><th>분원</th>
          <th class="cc">반</th><th class="cc">학생</th>
          <th class="cc">퇴원</th><th class="rt">퇴원율</th><th class="rt">상담률</th>
        </tr></thead>
        <tbody>
        ${allT.map((t,i)=>{
          const rank=i+1, rk=rank===1?'r1':rank===2?'r2':rank===3?'r3':'';
          const wrColor = t.withdrawRate>=15?'var(--neg)':t.withdrawRate>=8?'var(--warn)':'var(--ink-3)';
          return `<tr onclick="enterTeacher('${t.branchId}','${encodeURIComponent(t.teacher)}')">
            <td class="cc"><span class="rk ${rk}">${rank}</span></td>
            <td class="nm">${esc(t.teacher)}</td>
            <td><span class="branch-chip">${esc(t.branchName)}</span></td>
            <td class="cc">${t.classCount}</td>
            <td class="cc">${t.studentCount}</td>
            <td class="cc"><span class="wd-pill" style="color:${wrColor}">${t.withdrawCnt}</span></td>
            <td class="rt"><span class="wd-pill" style="color:${wrColor}">${t.withdrawRate}%</span></td>
            <td class="rt"><div class="cell-rate">
              <div class="mini-track"><div class="mini-fill" style="width:${t.rates.totalRate}%;background:${rateColor(t.rates.totalRate)}"></div></div>
              <span class="pct" style="color:${rateColor(t.rates.totalRate)}">${t.rates.totalRate}%</span>
            </div></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div></div>
    <div style="margin-top:10px;font-size:12px;color:var(--ink-3)">행을 클릭하면 해당 담임 상세로 이동합니다. 퇴원율 = 퇴원 ÷ (현재 재원 + 퇴원).</div>`;
  }

  el('content').innerHTML = html;
}
function branchSortBtn(key, label){
  return `<button class="sb-btn ${state.branchSort===key?'on':''}" onclick="setBranchSort('${key}')">${label}</button>`;
}
function setBranchSort(key){ state.branchSort=key; render(); }
function allTeacherSortBtn(key,label){
  return `<button class="sb-btn ${state.allTeacherSort===key?'on':''}" onclick="setAllTeacherSort('${key}')">${label}</button>`;
}
function setAllTeacherSort(key){ state.allTeacherSort=key; render(); }

/* ============================================================================
   10. 관리자 — 분원 상세 (담임별 현황)
   ============================================================================ */
function renderAdminBranchDetail(branchId){
  const b = getBranch(branchId);
  if(!b){ go('admin'); return; }
  const semId = state.semId;
  crumbs([{label:'통합 대시보드', go:'admin'},{label:b.name}]);

  const hc = headcountClean(branchId, semId);
  const brate = calcRates(activeRecordsOf(branchId, semId), branchId, semId);
  const teachers = teachersOf(branchId, semId);

  let html = `
    ${backLink('통합 대시보드', 'admin')}
    <div class="page-head">
      <h2>${esc(b.name)}</h2>
      <div class="sub">분원 상세 현황 · ${esc(db.semesters.find(s=>s.id===semId).name)}</div>
    </div>
    <div class="kpi-row c4">
      ${kpiCard('학기초 인원', hc.start, {unit:'명'})}
      ${kpiCard('신규생', hc.newCnt, {unit:'명'})}
      ${kpiCard('퇴원생', hc.withdraw, {unit:'명'})}
      ${kpiCard('현 재원생', hc.active, {unit:'명', accent:true})}
    </div>
    <div class="sect-head"><h3>전체 상담 진행률</h3></div>
    ${ratePanel(brate)}
    <div class="sect-head"><h3>담임별 현황</h3>
      ${teachers.length?teacherCardsSection(teachers, branchId, 'admin').sortBar:''}</div>`;

  if(teachers.length===0){
    html += emptyState('아직 데이터가 없습니다', '해당 분원이 전체명단을 업로드하면 담임별 현황이 표시됩니다.');
  } else {
    html += `<div class="card-grid g3">` + teacherCardsSection(teachers, branchId, 'admin').cards + `</div>`;
  }
  el('content').innerHTML = html;
}

/* 담임 카드 (관리자/분원 공용) — adminMode면 클릭 비활성(관리자는 담임상세 미진입 사양상 선택)
   사양: 관리자 분원상세 "담임 카드 클릭 → 담임 상세". 분원도 동일. 둘 다 진입 허용. */
function teacherCard(t, branchId, ctx, rank, mark){
  const r = t.rates;
  const onclick = ctx==='admin'
    ? `enterTeacher('${branchId}','${encodeURIComponent(t.teacher)}')`
    : `go('branch/teacher/${encodeURIComponent(t.teacher)}')`;
  const rankCls = rank===1?'r1':rank===2?'r2':rank===3?'r3':'';
  const cardCls = mark==='best'?' best' : mark==='worst'?' worst' : '';
  const tag = mark==='best'?'<span class="tag-best">최고</span>' : mark==='worst'?'<span class="tag-worst">최저</span>' : '';
  return `<div class="card clickable${cardCls}" onclick="${onclick}">
    ${rank?`<div class="rank-badge ${rankCls}">${rank}</div>`:''}
    <div class="card-top">
      <div>
        <div class="card-name">${esc(t.teacher)} ${tag}</div>
        <div class="card-sub">학생 ${t.studentCount}명 · 반 ${t.classCount}개${t.withdrawCnt?` · 퇴원 <b style="color:${t.withdrawRate>=15?'var(--neg)':t.withdrawRate>=8?'var(--warn)':'var(--ink-2)'}">${t.withdrawCnt}명 (${t.withdrawRate}%)</b>`:''}</div>
      </div>
      <div class="card-rate">
        <div class="r num" style="color:${rateColor(r.totalRate)}">${r.totalRate}%</div>
        <div class="rl">전체 상담률</div>
      </div>
    </div>
    ${stageBars(r)}
    <div class="card-foot">
      ${incompleteTag(r.incompleteStudents)}
      ${goArrow}
    </div>
  </div>`;
}

/* 담임 카드 묶음 — 정렬 버튼 + 순위 + 최고/최저 강조 */
function teacherCardsSection(teachers, branchId, ctx){
  const sortBar = `<div class="sort-bar">
    ${teacherSortBtn('rate_desc','상담률 높은순')}
    ${teacherSortBtn('rate_asc','낮은순')}
    ${teacherSortBtn('incomplete','미완료 많은순')}
    ${teacherSortBtn('name','이름순')}
  </div>`;
  const key = state.teacherSort;
  const arr = [...teachers];
  if(key==='rate_desc') arr.sort((a,b)=> b.rates.totalRate-a.rates.totalRate);
  else if(key==='rate_asc') arr.sort((a,b)=> a.rates.totalRate-b.rates.totalRate);
  else if(key==='incomplete') arr.sort((a,b)=> b.rates.incompleteStudents-a.rates.incompleteStudents);
  else arr.sort((a,b)=> a.teacher.localeCompare(b.teacher,'ko'));
  // 최고/최저는 상담률 기준(정렬 무관하게 고정 표시)
  const byRate = [...teachers].sort((a,b)=> b.rates.totalRate-a.rates.totalRate);
  const bestT = byRate.length ? byRate[0].teacher : null;
  const worstT = byRate.length>1 ? byRate[byRate.length-1].teacher : null;
  const cards = arr.map((t,i)=>{
    const rank = (key==='rate_desc') ? i+1 : null; // 상담률 높은순일 때만 1,2,3 표시
    const mark = t.teacher===bestT?'best' : t.teacher===worstT?'worst' : null;
    return teacherCard(t, branchId, ctx, rank, mark);
  }).join('');
  return { sortBar, cards };
}
function teacherSortBtn(key,label){
  return `<button class="sb-btn ${state.teacherSort===key?'on':''}" onclick="setTeacherSort('${key}')">${label}</button>`;
}
function setTeacherSort(key){ state.teacherSort=key; render(); }

/* 관리자 분원상세에서 담임 진입 — 컨텍스트 분원 고정 후 라우트 이동 */
function enterTeacher(branchId, teacherEnc){
  state.viewBranchId = branchId;
  go('branch/teacher/'+teacherEnc);
}

function emptyState(t, s){
  return `<div class="empty"><div class="ei">○</div><div class="et">${esc(t)}</div><div class="es">${esc(s)}</div></div>`;
}
/* ============================================================================
   11. 분원 — Dashboard (요약 + 담임별 현황). 업로드 버튼 없음(보는 화면)
   ============================================================================ */
function activeBranchId(){
  // admin이 분원상세에서 담임/반 진입 시 컨텍스트 분원, branch면 자기 분원
  return state.viewBranchId || (session.role==='branch' ? session.branchId : null);
}

function renderBranchDashboard(){
  const branchId = session.branchId;
  state.viewBranchId = branchId;
  const b = getBranch(branchId);
  const semId = state.semId;
  crumbs([{label:`${b.name} Dashboard`}]);

  const hc = headcountClean(branchId, semId);
  const rates = calcRates(activeRecordsOf(branchId, semId), branchId, semId);
  const teachers = teachersOf(branchId, semId);

  let html = `
    <div class="page-head">
      <h2>${esc(b.name)} Dashboard</h2>
      <div class="sub">${esc(db.semesters.find(s=>s.id===semId).name)} 운영 현황</div>
    </div>
    <div class="kpi-row c4">
      ${kpiCard('학기초 인원', hc.start, {unit:'명'})}
      ${kpiCard('신규생', hc.newCnt, {unit:'명'})}
      ${kpiCard('퇴원생', hc.withdraw, {unit:'명'})}
      ${kpiCard('현 재원생', hc.active, {unit:'명', accent:true})}
    </div>
    <div class="sect-head"><h3>전체 상담률</h3><span class="cnt">단계별 진행 현황</span></div>
    ${ratePanel(rates)}
    <div class="sect-head"><h3>담임별 현황</h3>
      ${teachers.length?teacherCardsSection(teachers, branchId, 'branch').sortBar:''}</div>`;

  if(teachers.length===0){
    html += emptyState('아직 데이터가 없습니다', '데이터관리 메뉴에서 전체명단과 상담이력을 업로드하면 현황이 표시됩니다.');
  } else {
    html += `<div class="card-grid g3">` + teacherCardsSection(teachers, branchId, 'branch').cards + `</div>`;
  }
  el('content').innerHTML = html;
}

/* ============================================================================
   12. 담임 상세 — 담당 반 목록
   ============================================================================ */
function renderTeacherDetail(teacher){
  const branchId = activeBranchId();
  if(!branchId){ go(session.role==='admin'?'admin':'branch'); return; }
  const b = getBranch(branchId);
  const semId = state.semId;
  const isAdmin = session.role==='admin';

  // crumbs & back differ by role
  if(isAdmin){
    crumbs([{label:'통합 대시보드', go:'admin'},{label:b.name, go:'admin/branch/'+branchId},{label:teacher}]);
  } else {
    crumbs([{label:`${b.name} Dashboard`, go:'branch'},{label:teacher}]);
  }

  const trecs = activeRecordsOf(branchId, semId).filter(r=>r.teacher===teacher);
  if(trecs.length===0){ el('content').innerHTML = emptyState('해당 담임 데이터가 없습니다',''); return; }
  const rates = calcRates(trecs, branchId, semId);
  const classes = classesOf(branchId, semId, teacher);
  const classCount = classes.length;

  const backTarget = isAdmin ? 'admin/branch/'+branchId : 'branch';
  const backLabel = isAdmin ? b.name : `${b.name} Dashboard`;

  let html = `
    ${backLink(backLabel, backTarget)}
    <div class="page-head">
      <h2>${esc(teacher)} <span style="font-size:14px;font-weight:500;color:var(--ink-3)">담임</span></h2>
      <div class="sub">${esc(b.name)} · 학생 ${trecs.length}명 · 반 ${classCount}개</div>
    </div>
    <div class="sect-head"><h3>담임 전체 상담 진행률</h3></div>
    ${ratePanel(rates)}
    <div class="sect-head"><h3>담당 반 목록</h3>
      <div class="sort-bar">
        ${classSortBtn('rate_desc','상담률 높은순')}
        ${classSortBtn('rate_asc','낮은순')}
        ${classSortBtn('name','반이름순')}
      </div></div>
    <div class="card-grid g4">`;

  // 반 정렬
  const ckey = state.classSort;
  const arr = [...classes];
  if(ckey==='rate_desc') arr.sort((a,b)=> b.rates.totalRate-a.rates.totalRate);
  else if(ckey==='rate_asc') arr.sort((a,b)=> a.rates.totalRate-b.rates.totalRate);
  else arr.sort((a,b)=> a.label.localeCompare(b.label,'ko'));
  const byRate = [...classes].sort((a,b)=> b.rates.totalRate-a.rates.totalRate);
  const bestC = byRate.length?byRate[0].className:null;
  const worstC = byRate.length>1?byRate[byRate.length-1].className:null;

  html += arr.map((cls,i)=>{
    const r = cls.rates;
    const rank = (ckey==='rate_desc')?i+1:null;
    const rankCls = rank===1?'r1':rank===2?'r2':rank===3?'r3':'';
    const mark = cls.className===bestC?'best':cls.className===worstC?'worst':null;
    const cardCls = mark==='best'?' best':mark==='worst'?' worst':'';
    const tag = mark==='best'?'<span class="tag-best">최고</span>':mark==='worst'?'<span class="tag-worst">최저</span>':'';
    return `<div class="card clickable${cardCls}" onclick="go('branch/class/${encodeURIComponent(teacher)}/${encodeURIComponent(cls.className)}')">
      ${rank?`<div class="rank-badge ${rankCls}">${rank}</div>`:''}
      <div class="card-top">
        <div>
          <div class="card-name">${esc(cls.label)} ${tag}</div>
          <div class="card-sub">학생 ${cls.studentCount}명</div>
        </div>
        <div class="card-rate">
          <div class="r num" style="color:${rateColor(r.totalRate)}">${r.totalRate}%</div>
          <div class="rl">반 상담률</div>
        </div>
      </div>
      ${stageBars(r)}
      <div class="card-foot">${incompleteTag(r.incompleteStudents)}${goArrow}</div>
    </div>`;
  }).join('');
  html += `</div>`;
  el('content').innerHTML = html;
}
function classSortBtn(key,label){
  return `<button class="sb-btn ${state.classSort===key?'on':''}" onclick="setClassSort('${key}')">${label}</button>`;
}
function setClassSort(key){ state.classSort=key; render(); }

/* ============================================================================
   13. 반 상세 — 엑셀형 상담표
   ============================================================================ */
function renderClassDetail(teacher, className){
  const branchId = activeBranchId();
  if(!branchId){ go(session.role==='admin'?'admin':'branch'); return; }
  const b = getBranch(branchId);
  const semId = state.semId;
  const isAdmin = session.role==='admin';

  const recs = activeRecordsOf(branchId, semId)
    .filter(r=>r.teacher===teacher && r.className===className)
    .sort((a,b)=> getStudent(a.studentId).name.localeCompare(getStudent(b.studentId).name,'ko'));
  if(recs.length===0){ el('content').innerHTML = emptyState('해당 반 데이터가 없습니다',''); return; }
  const rates = calcRates(recs, branchId, semId);
  const classLbl = recs[0].classLabel || classLabel(className) || className;

  const tBack = isAdmin ? 'admin/branch/'+branchId : 'branch';
  if(isAdmin){
    crumbs([{label:'통합', go:'admin'},{label:b.name, go:'admin/branch/'+branchId},
      {label:teacher, go:'branch/teacher/'+encodeURIComponent(teacher)},{label:classLbl}]);
  } else {
    crumbs([{label:`${b.name} Dashboard`, go:'branch'},
      {label:teacher, go:'branch/teacher/'+encodeURIComponent(teacher)},{label:classLbl}]);
  }

  // 표 행
  const rows = recs.map(rec=>{
    const stu = getStudent(rec.studentId);
    const originBadge = rec.origin==='new' ? '<span class="origin-badge new">신규</span>'
      : rec.origin==='return' ? '<span class="origin-badge return">복귀</span>' : '';
    const statusBadge = rec.status==='active'
      ? '<span class="status-badge active">재원</span>'
      : '<span class="status-badge withdraw">퇴원</span>';
    const cells = STAGES.map(stg=>{
      if(!isTarget(rec, stg, semId)){
        const why = (stg==='HC1'||stg==='HC2') ? '대상 아님(기존생)' : '대상 아님(입학 전 회차)';
        return `<td class="cc"><span class="cc-mark na" title="${why}">–</span></td>`;
      }
      const done = isDone(rec.studentId, branchId, semId, stg);
      if(done){
        return `<td class="cc"><span class="cc-mark done" title="상담 내용 보기"
          onclick="openCounseling('${rec.studentId}','${stg}','${esc(stu.name)}')">○</span></td>`;
      }
      // 오기재 의심: 이 단계에 mistag 상담 기록이 있으면 ⚠️로 표시 (완료 아님)
      const hasMistag = db.counselingHistories.some(c=>
        c.studentId===rec.studentId && c.branchId===branchId &&
        c.semesterId===semId && c.type===stg && c.mistag);
      if(hasMistag){
        return `<td class="cc"><span class="cc-mark mistag" title="대괄호 회차 오기재 의심 — 내용 확인"
          onclick="openCounseling('${rec.studentId}','${stg}','${esc(stu.name)}')">⚠</span></td>`;
      }
      return `<td class="cc"><span class="cc-mark undone" title="미완료">✕</span></td>`;
    }).join('');
    return `<tr>
      <td><div class="st-name">${esc(stu.name)}${originBadge}</div></td>
      <td><div>${esc(stu.school)}</div><div class="st-meta">${esc(stu.grade)}학년</div></td>
      <td><span class="code-chip">${esc(stu.code)}</span></td>
      <td>${statusBadge}</td>
      <td style="color:var(--ink-2);font-size:12.5px">${esc(rec.note||'–')}</td>
      ${cells}
    </tr>`;
  }).join('');

  // 하단 진행률
  const footCells = STAGES.map(s=>{
    const st = rates.stages[s];
    return `<div class="tf-cell"><div class="tfl">${s}</div>
      <div class="tfv num" style="color:${rateColor(st.rate)}">${st.rate==null?'–':st.rate+'%'}</div></div>`;
  }).join('');
  const footTotal = `<div class="tf-cell total"><div class="tfl">반 총 상담률</div>
      <div class="tfv num">${rates.totalRate}%</div></div>`;

  const backTarget = 'branch/teacher/'+encodeURIComponent(teacher);
  let html = `
    ${backLink(teacher+' 담임', backTarget)}
    <div class="page-head">
      <h2>${esc(classLbl)} <span style="font-size:14px;font-weight:500;color:var(--ink-3)">상담표</span></h2>
      <div class="sub">${esc(b.name)} · ${esc(teacher)} 담임 · 학생 ${recs.length}명</div>
    </div>
    <div class="table-wrap">
      <div class="table-scroll">
        <table class="grid">
          <thead><tr>
            <th>학생명</th><th>학교/학년</th><th>회원코드</th><th>상태</th><th>특이사항</th>
            <th class="cc">HC1</th><th class="cc">HC2</th><th class="cc">MC1</th><th class="cc">MC2</th><th class="cc">MC3</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="table-foot">${footCells}${footTotal}</div>
    </div>
    <div style="margin-top:14px;font-size:12px;color:var(--ink-3)">
      ○ 완료(클릭 시 상담 내용) · ✕ 미완료 · ⚠ 회차 오기재 의심(대괄호 잘못 표기) · – 상담 대상 아님(기존생은 HC 제외)
    </div>`;
  el('content').innerHTML = html;
}

/* ============================================================================
   14. 상담 내용 팝업
   ============================================================================ */
function openCounseling(studentId, stage, name){
  const branchId = activeBranchId();
  const list = historiesOf(studentId, branchId, state.semId, stage);
  const records = list.map(c=>`
    <div class="cs-record">
      <div class="cs-meta">
        <span class="cs-tag">${esc(c.type)}</span>
        <span class="cs-date num">${esc(c.date)}</span>
        <span class="cs-by">상담자 ${esc(c.counselor||'–')}</span>
      </div>
      <div class="cs-body">${esc(c.content)}</div>
    </div>`).join('') || `<div class="empty"><div class="et">상담 기록이 없습니다</div></div>`;
  openModal(`
    <div class="modal-head">
      <div><h3>${esc(name)} · ${esc(stage)} 상담 내용</h3>
        <div class="mh-sub">${list.length}건의 상담 기록</div></div>
      <button class="modal-x" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">${records}</div>
  `);
}
/* ============================================================================
   15. 분원 — 데이터관리 (엑셀 업로드 전용)
   ============================================================================ */
function renderDataManagement(){
  const branchId = session.branchId;
  const b = getBranch(branchId);
  const semId = state.semId;
  crumbs([{label:'데이터관리'}]);

  const recs = recordsOf(branchId, semId);
  const histCount = db.counselingHistories.filter(c=>c.branchId===branchId && c.semesterId===semId).length;

  el('content').innerHTML = `
    <div class="page-head">
      <h2>데이터관리</h2>
      <div class="sub">${esc(b.name)} · ${esc(db.semesters.find(s=>s.id===semId).name)} · 전체명단 ${recs.length}명 · 상담이력 ${histCount}건</div>
    </div>
    <div class="dm-grid">
      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--brand-soft);color:var(--brand)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></svg>
          </div>
          <div><h3>전체명단 업로드</h3></div>
        </div>
        <div class="pd">학생 DB이자 학기별 반·담임 정보의 기준입니다. 정상 LMS에서 내려받은 전체명단 엑셀을 그대로 올리면 됩니다. 특이사항 열에 '신규생' 또는 '복학생'이 적힌 학생만 HC1·HC2 대상이 됩니다. 같은 학생을 다시 올리면 최신 반·담임 정보로 갱신됩니다.</div>
        <div class="dropzone" id="rosterZone">
          <div class="dz-i">＋</div>
          <div class="dz-t">엑셀 파일을 끌어다 놓거나 클릭</div>
          <div class="dz-s">.xlsx · .xls · .csv</div>
        </div>
        <input type="file" id="rosterFile" accept=".xlsx,.xls,.csv" hidden>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--pos-soft);color:var(--pos)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          </div>
          <div><h3>상담이력 업로드</h3></div>
        </div>
        <div class="pd"><b>매달 누적 추가됩니다.</b> 새 파일을 올려도 기존 이력을 덮어쓰지 않고 쌓입니다. 같은 상담은 자동으로 중복 제외됩니다. 분류가 '상담'인 건만 반영하고, 내용의 [HC1]~[MC3] 태그로 완료 단계를 판정합니다.</div>
        <div class="dropzone" id="historyZone">
          <div class="dz-i">＋</div>
          <div class="dz-t">엑셀 파일을 끌어다 놓거나 클릭</div>
          <div class="dz-s">.xlsx · .xls · .csv · 누적 추가</div>
        </div>
        <input type="file" id="historyFile" accept=".xlsx,.xls,.csv" hidden>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-head"><div class="pi" style="background:var(--pos-soft);color:var(--pos)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></div>
        <div><h3>상담이력 업로드 내역</h3></div></div>
      <div class="pd">업로드한 묶음별로 되돌릴 수 있습니다. 잘못 올린 묶음만 골라 삭제하면 그때 추가된 상담만 사라지고, 다른 업로드는 그대로 남습니다.</div>
      ${renderHistoryBatches(branchId, semId)}
    </div>

    <div class="panel" style="margin-top:16px;border-color:var(--neg-soft)">
      <div class="panel-head"><div class="pi" style="background:var(--neg-soft);color:var(--neg)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></div>
        <div><h3>데이터 비우기</h3></div></div>
      <div class="pd">필요한 것만 골라서 비울 수 있습니다. 전체명단과 상담이력은 따로 지워집니다.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
        <button class="btn" style="border-color:var(--neg-soft);color:var(--neg)" onclick="confirmClearHistory()">상담이력 전체 삭제</button>
        <button class="btn" style="border-color:var(--neg-soft);color:var(--neg)" onclick="confirmClearRoster()">전체명단 삭제</button>
        <button class="btn" style="border-color:var(--neg-soft);color:var(--neg)" onclick="confirmReset()">전체 초기화</button>
      </div>
    </div>`;

  wireDropzone('rosterZone','rosterFile', f=> importRoster(f, branchId, semId));
  wireDropzone('historyZone','historyFile', f=> importHistory(f, branchId, semId));
}

/* 상담이력 업로드 묶음 목록 (최신순). 각 묶음에 현재 남아있는 건수 표시 + 삭제 */
function renderHistoryBatches(branchId, semId){
  const batches = (db.uploadBatches||[])
    .filter(x=>x.kind==='history' && x.branchId===branchId && x.semesterId===semId)
    .sort((a,b)=> (b.uploadedAt||'').localeCompare(a.uploadedAt||''));
  if(batches.length===0){
    return `<div style="padding:14px 2px;color:var(--ink-3);font-size:12.5px">아직 업로드한 상담이력이 없습니다.</div>`;
  }
  // 오래된 것이 1번이 되도록 번호 매김
  const order = new Map();
  [...batches].reverse().forEach((x,i)=> order.set(x.id, i+1));
  return `<div class="batch-list">` + batches.map(x=>{
    const live = db.counselingHistories.filter(c=>c.batchId===x.id).length;
    return `<div class="batch-item">
      <div class="batch-no">${order.get(x.id)}</div>
      <div class="batch-main">
        <div class="batch-name">${esc(x.fileName)}</div>
        <div class="batch-meta">${esc(x.uploadedAt||'')} · 현재 ${live}건 남음 (업로드 시 추가 ${x.added}, 중복 ${x.dup})</div>
      </div>
      <button class="btn sm" style="border-color:var(--neg-soft);color:var(--neg)"
        onclick="confirmDeleteBatch('${x.id}')">이 업로드 삭제</button>
    </div>`;
  }).join('') + `</div>`;
}

/* 특정 업로드 묶음만 삭제 — 그 batchId의 상담만 제거 */
function confirmDeleteBatch(batchId){
  const x = (db.uploadBatches||[]).find(b=>b.id===batchId);
  if(!x) return;
  const live = db.counselingHistories.filter(c=>c.batchId===batchId).length;
  openConfirm('이 업로드만 삭제',
    `${x.fileName} (${x.uploadedAt})\n이 업로드로 추가된 상담 ${live}건이 삭제됩니다. 다른 업로드 묶음은 그대로 유지됩니다.`,
    ()=>{
      db.counselingHistories = db.counselingHistories.filter(c=>c.batchId!==batchId);
      db.uploadBatches = db.uploadBatches.filter(b=>b.id!==batchId);
      saveDB(); closeModal(); toast(`${live}건 삭제 완료`,'ok'); render();
    });
}

/* 상담이력 전체 삭제 (전체명단은 유지) */
function confirmClearHistory(){
  const branchId=session.branchId, semId=state.semId;
  const cnt = db.counselingHistories.filter(c=>c.branchId===branchId && c.semesterId===semId).length;
  openConfirm('상담이력 전체 삭제',
    `이 분원·학기의 상담이력 ${cnt}건이 모두 삭제됩니다. 전체명단(학생·반·담임)은 그대로 유지됩니다.`,
    ()=>{
      db.counselingHistories = db.counselingHistories.filter(c=>!(c.branchId===branchId && c.semesterId===semId));
      db.uploadBatches = (db.uploadBatches||[]).filter(x=>!(x.kind==='history' && x.branchId===branchId && x.semesterId===semId));
      saveDB(); closeModal(); toast('상담이력 삭제 완료','ok'); render();
    });
}

/* 전체명단 삭제 (상담이력은 유지) */
function confirmClearRoster(){
  const branchId=session.branchId, semId=state.semId;
  const cnt = recordsOf(branchId, semId).length;
  openConfirm('전체명단 삭제',
    `이 분원·학기의 학생 명단 ${cnt}명이 삭제됩니다. 상담이력 기록 자체는 남지만, 명단이 없으면 상담률은 계산되지 않습니다. 보통은 새 명단을 다시 업로드하기 직전에만 사용하세요.`,
    ()=>{
      db.semesterRecords = db.semesterRecords.filter(r=>!(r.branchId===branchId && r.semesterId===semId));
      db.studentMovements = (db.studentMovements||[]).filter(m=>!(m.branchId===branchId && m.semesterId===semId));
      saveDB(); closeModal(); toast('전체명단 삭제 완료','ok'); render();
    });
}

/* ============================================================================
   15-2. 분원 — 학생관리 (신규생 추가 / 퇴원 처리 / 이동 이력)
   ============================================================================ */
function renderStudentManagement(){
  const branchId = session.branchId;
  const b = getBranch(branchId);
  const semId = state.semId;
  crumbs([{label:'학생관리'}]);

  const recs = recordsOf(branchId, semId);
  const movements = db.studentMovements
    .filter(m=>m.branchId===branchId && m.semesterId===semId)
    .sort((a,b)=> (b.date||'').localeCompare(a.date||''));

  // 기존 반 목록 (className 고유값 기준, 담임도 함께). 드롭다운 선택용.
  const classMap = new Map();
  activeRecordsOf(branchId, semId).forEach(r=>{
    if(!classMap.has(r.className)){
      classMap.set(r.className, { className:r.className, label:r.classLabel||classLabel(r.className)||r.className, teacher:r.teacher });
    }
  });
  const classList = [...classMap.values()].sort((a,b)=> a.label.localeCompare(b.label,'ko'));

  el('content').innerHTML = `
    <div class="page-head">
      <h2>학생관리</h2>
      <div class="sub">${esc(b.name)} · ${esc(db.semesters.find(s=>s.id===semId).name)} · 신규생 추가와 퇴원 처리를 합니다</div>
    </div>
    <div class="dm-grid">
      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--brand-soft);color:var(--brand)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M19 8v6M22 11h-6"/></svg>
          </div>
          <div><h3>신규생 추가</h3></div>
        </div>
        <div class="pd">학기 중 입학한 학생을 수동 등록합니다. 신규생은 HC1·HC2 대상이며, MC는 입학일 기준으로 그 달부터의 회차만 대상이 됩니다. (예: 여름학기 7월 입학 → MC1 제외, MC2·MC3 대상)</div>
        <div class="form-row">
          <div class="field"><label>학생명</label><input id="nsName" placeholder="이름"></div>
          <div class="field"><label>회원코드</label><input id="nsCode" placeholder="코드"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>학교</label><input id="nsSchool" placeholder="학교"></div>
          <div class="field"><label>학년</label><input id="nsGrade" placeholder="학년"></div>
        </div>
        <div class="form-row">
          <div class="field full"><label>반 선택</label>
            <select id="nsClassSelect">
              <option value="">기존 반에서 선택…</option>
              ${classList.map(c=>`<option value="${esc(c.className)}" data-teacher="${esc(c.teacher)}">${esc(c.label)} · ${esc(c.teacher)}</option>`).join('')}
              <option value="__new__">+ 새 반 직접 입력</option>
            </select>
          </div>
        </div>
        <div class="form-row" id="nsNewClassRow" style="display:none">
          <div class="field"><label>새 반명 (엑셀과 동일하게)</label><input id="nsClass" placeholder="예: [DSC2]SU1/MWF/DSC2/H"></div>
          <div class="field"><label>담임명</label><input id="nsTeacher" placeholder="담임"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>입학일 (등원일)</label><input id="nsDate" type="date"></div>
        </div>
        <button class="btn primary" style="width:100%" onclick="addNewStudent()">신규생 등록</button>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--neg-soft);color:var(--neg)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M17 11h6"/></svg>
          </div>
          <div><h3>퇴원 처리</h3></div>
        </div>
        <div class="pd">학생 상태를 재원→퇴원으로 변경합니다. 현재 재원생 수에서 제외되지만 과거 데이터와 상담이력은 보존됩니다.</div>
        <div class="field full" style="margin-bottom:8px">
          <label>학생 검색 (이름 또는 회원코드)</label>
          <input id="wdSearch" placeholder="예: 김태양" autocomplete="off" oninput="renderWdResults()">
        </div>
        <div id="wdResults" class="wd-results"></div>
        <input type="hidden" id="wdSelect" value="">
        <div id="wdPicked" class="wd-picked" style="display:none"></div>
        <div class="field full" style="margin:10px 0">
          <label>사유 (선택)</label><input id="wdMemo" placeholder="예: 타지역 이사">
        </div>
        <button class="btn" style="width:100%;border-color:var(--neg-soft);color:var(--neg)" onclick="withdrawStudent()">퇴원 처리</button>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-head"><div class="pi" style="background:var(--brand-soft);color:var(--brand)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div>
        <div><h3>수동 등록 학생 관리</h3></div></div>
      <div class="pd">학생관리에서 직접 추가한 신규생입니다. 잘못 입력한 이름·반·담임·입학일을 수정하거나 삭제할 수 있습니다.</div>
      ${renderManualStudents(branchId, semId)}
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-head"><div class="pi" style="background:var(--surface-2);color:var(--ink-3)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg></div>
        <div><h3>학생 이동 이력</h3></div></div>
      <div class="log-list">
        ${movements.length ? movements.map(m=>{
          const s=getStudent(m.studentId);
          const label={new:'신규 등록',withdraw:'퇴원',return:'복귀',classChange:'반 이동'}[m.type]||m.type;
          const color={new:'var(--brand)',withdraw:'var(--neg)',return:'var(--warn)',classChange:'var(--ink-2)'}[m.type];
          return `<div class="log-item"><span class="lt">${esc(m.date||'')}</span>
            <span class="lb"><b style="color:${color}">${label}</b> · ${esc(s?s.name:'?')} ${m.memo?'· '+esc(m.memo):''}</span></div>`;
        }).join('') : '<div style="padding:14px;color:var(--ink-3);font-size:12.5px">이동 이력이 없습니다.</div>'}
      </div>
    </div>`;

  // 반 선택 드롭다운: '새 반 직접 입력' 고르면 입력칸 표시
  const csel = el('nsClassSelect');
  if(csel){
    csel.onchange = ()=>{
      el('nsNewClassRow').style.display = csel.value==='__new__' ? 'flex' : 'none';
    };
  }
}

/* 수동 등록 학생 목록 (수정/삭제) — 학생관리에서 직접 추가한 신규생만 */
function renderManualStudents(branchId, semId){
  // 수동 등록 = '수동 등록' 메모가 있는 new 이동이력을 가진 학생
  const manualIds = new Set(db.studentMovements
    .filter(m=>m.branchId===branchId && m.semesterId===semId && m.type==='new' && m.memo==='수동 등록')
    .map(m=>m.studentId));
  const recs = recordsOf(branchId, semId)
    .filter(r=> manualIds.has(r.studentId))
    .sort((a,b)=>{ const sa=getStudent(a.studentId),sb=getStudent(b.studentId);
      return (sa?sa.name:'').localeCompare(sb?sb.name:'','ko'); });
  if(recs.length===0){
    return `<div style="padding:14px 2px;color:var(--ink-3);font-size:12.5px">수동 등록한 학생이 없습니다. (전체명단 엑셀로 올린 학생은 명단을 다시 업로드해 수정하세요.)</div>`;
  }
  return `<div class="table-wrap" style="margin-top:12px"><div class="table-scroll">
    <table class="grid">
      <thead><tr><th>학생명</th><th>회원코드</th><th>반</th><th>담임</th><th>입학일</th><th>상태</th><th class="cc">관리</th></tr></thead>
      <tbody>
      ${recs.map(r=>{
        const s=getStudent(r.studentId);
        const st = r.status==='active'?'<span class="status-badge active">재원</span>':'<span class="status-badge withdraw">퇴원</span>';
        return `<tr>
          <td class="st-name">${esc(s.name)}</td>
          <td><span class="code-chip">${esc(s.code)}</span></td>
          <td>${esc(r.classLabel||r.className)}</td>
          <td>${esc(r.teacher)}</td>
          <td class="num">${esc(r.enrollDate||'–')}</td>
          <td>${st}</td>
          <td class="cc">
            <button class="btn sm" onclick="openEditStudent('${r.id}')">수정</button>
            <button class="btn sm" style="color:var(--neg);margin-left:4px" onclick="confirmDeleteStudent('${r.id}')">삭제</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>
  </div></div>`;
}

/* 학생 정보 수정 모달 */
function openEditStudent(recId){
  const rec = db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s = getStudent(rec.studentId);
  openModal(`
    <div class="modal-head"><div><h3>학생 정보 수정</h3>
      <div class="mh-sub">${esc(s.code)}</div></div>
      <button class="modal-x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-row">
        <div class="field"><label>학생명</label><input id="edName" value="${esc(s.name)}"></div>
        <div class="field"><label>회원코드</label><input id="edCode" value="${esc(s.code)}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>학교</label><input id="edSchool" value="${esc(s.school||'')}"></div>
        <div class="field"><label>학년</label><input id="edGrade" value="${esc(s.grade||'')}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>반명</label><input id="edClass" value="${esc(rec.classLabel||rec.className||'')}"></div>
        <div class="field"><label>담임명</label><input id="edTeacher" value="${esc(rec.teacher||'')}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>입학일 (등원일)</label><input id="edDate" type="date" value="${esc(rec.enrollDate||'')}"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">취소</button>
      <button class="btn primary" id="edSave">저장</button>
    </div>`);
  el('edSave').onclick = ()=> saveEditStudent(recId);
}
function saveEditStudent(recId){
  const rec = db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s = getStudent(rec.studentId);
  const name=el('edName').value.trim(), code=el('edCode').value.trim();
  if(!name||!code){ toast('학생명과 회원코드는 필수입니다','err'); return; }
  // 회원코드 중복 체크(자기 자신 제외)
  if(code!==s.code && db.students.some(x=>x.code===code && x.id!==s.id)){
    toast('이미 사용 중인 회원코드입니다','err'); return; }
  s.name=name; s.code=code;
  s.school=el('edSchool').value.trim(); s.grade=el('edGrade').value.trim();
  const inClass=el('edClass').value.trim()||'미배정';
  rec.className=inClass; rec.classLabel=inClass;
  rec.teacher=el('edTeacher').value.trim()||'미배정';
  rec.enrollDate=el('edDate').value;
  saveDB(); closeModal(); toast('수정 완료','ok'); render();
}
/* 수동 등록 학생 삭제 — 학기레코드 + 이동이력 제거 (상담이력은 보존) */
function confirmDeleteStudent(recId){
  const rec = db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s = getStudent(rec.studentId);
  openConfirm('학생 삭제',
    `${s.name} (${s.code}) 학생을 이번 학기 명단에서 삭제합니다. 잘못 등록한 학생을 지울 때 사용하세요.`,
    ()=>{
      db.semesterRecords = db.semesterRecords.filter(r=>r.id!==recId);
      db.studentMovements = db.studentMovements.filter(m=>!(m.studentId===rec.studentId && m.semesterId===rec.semesterId && m.branchId===rec.branchId));
      saveDB(); closeModal(); toast('삭제 완료','ok'); render();
    });
}

function wireDropzone(zoneId, inputId, cb){
  const zone = el(zoneId), input = el(inputId);
  if(!zone) return;
  zone.onclick = ()=> input.click();
  input.onchange = ()=>{ if(input.files[0]) cb(input.files[0]); input.value=''; };
  ['dragover','dragenter'].forEach(ev=> zone.addEventListener(ev, e=>{ e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev=> zone.addEventListener(ev, e=>{ e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e=>{ const f=e.dataTransfer.files[0]; if(f) cb(f); });
}

/* ============================================================================
   16. 파일 파싱 & 임포트 (엑셀 .xlsx/.xls + CSV 공용)
   ============================================================================ */

/* CSV 텍스트 → 2차원 배열 (엑셀 없는 .csv 폴백용) */
function parseCSV(text){
  const rows=[]; let row=[], cur='', q=false;
  text = text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){
      if(ch==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else q=false; }
      else cur+=ch;
    } else {
      if(ch==='"') q=true;
      else if(ch===','){ row.push(cur); cur=''; }
      else if(ch==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; }
      else cur+=ch;
    }
  }
  if(cur!==''||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=> r.some(c=> String(c).trim()!==''));
}

/* 파일(엑셀 또는 CSV) → 2차원 배열(문자열). 첫 행이 헤더. */
function readTable(file, cb){
  const name = (file.name||'').toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
  const r = new FileReader();
  r.onerror = ()=> toast('파일을 읽지 못했습니다','err');
  if(isExcel){
    if(typeof XLSX==='undefined'){ toast('엑셀 모듈 로드 실패 — 인터넷 연결을 확인하세요','err'); return; }
    r.onload = ()=>{
      try{
        const wb = XLSX.read(new Uint8Array(r.result), {type:'array'});
        const ws = wb.Sheets[wb.SheetNames[0]];
        // 빈 셀도 ''로 채워서 열 위치 보존
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:false});
        cb(rows.map(row=> row.map(c=> c==null?'':String(c))));
      }catch(e){ console.error(e); toast('엑셀을 해석하지 못했습니다','err'); }
    };
    r.readAsArrayBuffer(file);
  } else {
    r.onload = ()=> cb(parseCSV(r.result));
    r.readAsText(file,'UTF-8');
  }
}

/* 반 이름이 실제 수업반인지 (대괄호 레벨 코드가 있으면 수업반).
   셔틀비/CHESS_Test 등은 대괄호가 없어 제외 대상 */
function isRealClass(raw){
  return !!String(raw||'').match(/\[([A-Za-z0-9]+)\]/);
}
/* 반 이름에서 레벨 코드만 추출: "[PA1]SU3/MWF/PA1(1)_E6/G" → "PA1" */
function classLevel(raw){
  const m = String(raw||'').match(/\[([A-Za-z0-9]+)\]/);
  return m ? m[1] : '';
}
/* 화면 표시용 깔끔한 라벨 생성.
   "[PA1]SU3/MWF/PA1(1)_E6/G" → "월수금 3부 · PA1(1)_E6"
   시간대가 없는 반(체스 등)은 "월수금 · 반이름", 요일도 없으면 반이름만.
   반 구분은 항상 전체 이름(className)으로 하므로 라벨이 겹쳐도 데이터는 안전. */
function classLabel(raw){
  const s = String(raw||'');
  const level = classLevel(s);
  const body = s.replace(/^\[[^\]]*\]/,'');
  const parts = body.split('/').map(x=>x.trim()).filter(Boolean);
  // 레벨로 시작하는 조각(예: "PA1(1)_E6", "A1_M1") = 반 코어 이름
  const core = parts.find(p=> level && p.toUpperCase().startsWith(level.toUpperCase())) || level || s;
  // 요일 (MWF=월수금, TTH=화목)
  const dayPart = parts.find(p=> /^(MWF|TTH|TTHS|MTWTF|MW|WF|MWTF)$/i.test(p));
  const dayMap = {MWF:'월수금', TTH:'화목', MW:'월수', WF:'수금', MWTF:'월화수금', MTWTF:'매일'};
  const day = dayPart ? (dayMap[dayPart.toUpperCase()] || dayPart) : '';
  // 시간대 (SU1, SP2 등 학기약자+숫자 → n부). 체스반 등은 없을 수 있음.
  const timePart = parts.find(p=> /^[A-Z]{2}\d+$/i.test(p));
  const time = timePart ? (timePart.match(/\d+$/)[0]+'부') : '';
  // 앞부분: "요일 시간부" (있는 것만). 예: "월수금 3부", "화목", "3부"
  const front = [day, time].filter(Boolean).join(' ');
  // 최종: "월수금 3부 · PA1(1)_E6"
  return [front, core].filter(Boolean).join(' · ');
}

function importRoster(file, branchId, semId){
  readTable(file, async rows=>{
    if(rows.length<2){ toast('데이터가 없습니다','err'); return; }
    const header = rows[0].map(h=>String(h).trim());
    // 정상 LMS 전체명단 컬럼명에 맞춘 매핑 (별칭 포함)
    const idx = mapHeader(header, {
      name:['이름','학생명','성명'],
      code:['회원코드','코드','학생코드'],
      school:['학교'],
      grade:['학년'],
      cls:['반 이름','반이름','반명','반','클래스'],
      teacher:['담임선생님','담임명','담임','선생님'],
      note:['특이사항','비고','메모'],
      startdate:['반 시작일','반시작일','시작일','등원일','입학일']
    });
    if(idx.name<0 || idx.code<0){ toast('이름·회원코드 열을 찾지 못했습니다','err'); return; }
    let added=0, updated=0, excluded=0;
    rows.slice(1).forEach(r=>{
      const name=String(r[idx.name]||'').trim();
      const code=String(r[idx.code]||'').trim();
      if(!name||!code) return;
      // 반 이름: 전체 문자열로 반을 구분(같은 레벨이라도 요일/시간/학년/교실 다르면 다른 반).
      // 화면 표시는 깔끔한 라벨 사용. 대괄호 레벨이 없으면(셔틀 등) 제외.
      const rawClass = idx.cls>=0 ? String(r[idx.cls]||'').trim() : '';
      if(!isRealClass(rawClass)){ excluded++; return; }
      const classFull = rawClass;              // 고유 식별자 (전체 이름)
      const classLbl = classLabel(rawClass);   // 표시용 라벨
      const note = idx.note>=0 ? String(r[idx.note]||'').trim() : '';
      const origin = /신규/.test(note)?'new' : /복귀/.test(note)?'return' : 'start';
      const targetType = (origin==='new'||origin==='return')?'HCMC':'MC';
      const teacher = String(r[idx.teacher]||'').trim() || '미배정';
      const school = idx.school>=0 ? String(r[idx.school]||'').trim() : '';
      const grade  = idx.grade>=0 ? String(r[idx.grade]||'').trim() : '';
      // 신규·복귀생이면 반 시작일을 입학일(enrollDate)로 저장 → MC 대상 월 판정에 사용
      let enrollDate = '';
      if(origin==='new' || origin==='return'){
        const rawDate = idx.startdate>=0 ? String(r[idx.startdate]||'').trim() : '';
        const dm = rawDate.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
        if(dm) enrollDate = `${dm[1]}-${dm[2].padStart(2,'0')}-${dm[3].padStart(2,'0')}`;
      }
      // 학생 DB upsert (회원코드 기준)
      let stu = db.students.find(s=>s.code===code);
      if(!stu){ stu={id:uid('st'),code,name,school,grade}; db.students.push(stu); }
      else { stu.name=name; if(school)stu.school=school; if(grade)stu.grade=grade; }
      // 학기레코드 upsert
      let rec = db.semesterRecords.find(x=>x.studentId===stu.id && x.branchId===branchId && x.semesterId===semId);
      if(!rec){
        rec={id:uid('rec'),studentId:stu.id,branchId,semesterId:semId,
          className:classFull,classLabel:classLbl,teacher,note,targetType,status:'active',origin,enrollDate};
        db.semesterRecords.push(rec); added++;
        if(origin==='new') db.studentMovements.push({id:uid('mv'),studentId:stu.id,branchId,semesterId:semId,type:'new',date:enrollDate||today(),memo:'명단 업로드'});
        if(origin==='return') db.studentMovements.push({id:uid('mv'),studentId:stu.id,branchId,semesterId:semId,type:'return',date:enrollDate||today(),memo:'명단 업로드'});
      } else {
        rec.className=classFull; rec.classLabel=classLbl; rec.teacher=teacher;
        if(note) rec.note=note; rec.targetType=targetType;
        if(enrollDate) rec.enrollDate=enrollDate;
        if(rec.status==='withdraw') rec.status='active';
        updated++;
      }
    });
    await saveDB();
    toast(`전체명단 반영 · 신규 ${added}, 갱신 ${updated}${excluded?`, 제외 ${excluded}`:''}`,'ok');
    render();
  });
}

function importHistory(file, branchId, semId){
  readTable(file, async rows=>{
    if(rows.length<2){ toast('데이터가 없습니다','err'); return; }
    const header = rows[0].map(h=>String(h).trim());
    const idx = mapHeader(header,{
      code:['회원코드','코드'],
      name:['이름','학생명'],
      category:['분류','구분'],
      content:['내용','상담내용','상담'],
      date:['날짜','상담일','일자'],
      status:['상태'],
      counselor:['상담자','담임','작성자']
    });
    if(idx.content<0){ toast('내용 열을 찾지 못했습니다','err'); return; }
    // 이번 업로드를 하나의 배치로 기록
    const batchId = uid('batch');
    let added=0, dup=0, skip=0, notCounsel=0, prevSem=0, misTagCnt=0;
    rows.slice(1).forEach(r=>{
      // 분류가 '상담'인 건만 반영 (수납/기타/성적 등 제외)
      if(idx.category>=0){
        const cat=String(r[idx.category]||'').trim();
        if(cat && cat!=='상담'){ notCounsel++; return; }
      }
      const code=String(r[idx.code]||'').trim();
      const content=String(r[idx.content]||'').replace(/\\n/g,'\n').trim();
      const date=normDate(String(r[idx.date]||'').trim());
      if(!content){ return; }
      const stu = db.students.find(s=>s.code===code) ||
                  db.students.find(s=>s.name===String(r[idx.name]||'').trim());
      if(!stu){ skip++; return; }
      // 태그로 단계 판정 — 대괄호 안의 모든 단계를 추출.
      // [MC2] 단일은 물론 [HC2+MC2], [HC2/MC2], [HC2,MC2], [HC2 MC2] 같은 복합표기도 각각 인정.
      const tags = [];
      const bracketRe = /\[([^\]]+)\]/g;   // 대괄호 안 내용 통째로
      let bm;
      while((bm = bracketRe.exec(content)) !== null){
        const inner = bm[1].toUpperCase();
        (inner.match(/HC1|HC2|MC1|MC2|MC3/g) || []).forEach(t=> tags.push(t));
      }
      const uniqTags = [...new Set(tags)];
      if(uniqTags.length===0){ skip++; return; } // 단계 태그 없는 상담은 완료율과 무관 → 미반영
      uniqTags.forEach(type=>{
        // ★ 회차-월 판정: 이전학기 상담이면 현재 학기 집계에서 제외
        const timing = stageTimingCheck(type, date, semId);
        if(timing==='prev'){ prevSem++; return; }  // 이전 학기 상담 → 현재 학기에 미반영
        const isMistag = (timing==='mistag');      // 오기재 의심 → 저장하되 완료 집계 제외

        // 같은 학생·같은 학기·같은 단계의 기존 상담을 찾음
        const prev = db.counselingHistories.find(c=>
          c.studentId===stu.id && c.branchId===branchId &&
          c.semesterId===semId && c.type===type);
        if(prev){
          // 내용·날짜가 완전히 같으면 변화 없음(중복)
          if(prev.content===content && prev.date===date){ dup++; return; }
          // 내용이 바뀌었으면 최신 내용으로 교체(갱신)
          prev.content = content;
          prev.date = date;
          prev.counselor = String(r[idx.counselor]||'').trim();
          prev.batchId = batchId;
          prev.mistag = isMistag;
          if(isMistag) misTagCnt++;
          added++;  // 갱신도 반영 건수로 카운트
          return;
        }
        // 기존에 없던 단계면 새로 추가
        db.counselingHistories.push({id:uid('ch'),studentId:stu.id,branchId,semesterId:semId,
          date,type,content,counselor:String(r[idx.counselor]||'').trim(), batchId, mistag:isMistag});
        if(isMistag) misTagCnt++;
        added++;
      });
    });
    // 실제로 추가된 게 있을 때만 배치 기록 (전부 중복이면 묶음 안 남김)
    if(added>0){
      db.uploadBatches.push({
        id:batchId, branchId, semesterId:semId, kind:'history',
        fileName:file.name||'상담이력', uploadedAt:nowStamp(),
        added, dup, skip
      });
    }
    await saveDB();
    let extra = '';
    if(prevSem>0) extra += `, 이전학기 제외 ${prevSem}`;
    if(misTagCnt>0) extra += `, 오기재 의심 ${misTagCnt}`;
    toast(`상담이력 누적 · 추가 ${added}, 중복 ${dup}, 미매칭 ${skip}${extra}`,'ok');
    render();
  });
}

/* "YYYY-MM-DD HH:MM" 형태의 업로드 시각 */
function nowStamp(){
  const d=new Date(), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mapHeader(header, spec){
  const idx={};
  for(const key in spec){
    idx[key] = header.findIndex(h=> spec[key].some(a=> h===a || h.includes(a)));
  }
  return idx;
}
function today(){ const d=new Date(); return d.toISOString().slice(0,10); }
/* "2026.05.31 21:45", "2026-5-3", "2026/12/03" 등 → "YYYY-MM-DD" */
function normDate(s){
  if(!s) return today();
  s=String(s).replace(/[./]/g,'-');
  const m=s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return s.trim();
}

/* ----- 신규/퇴원 수동 ----- */
function addNewStudent(){
  const branchId=session.branchId, semId=state.semId;
  const name=el('nsName').value.trim(), code=el('nsCode').value.trim();
  if(!name||!code){ toast('학생명과 회원코드는 필수입니다','err'); return; }
  const enrollDate=el('nsDate').value;  // "2026-07-15" (캘린더 선택값)
  if(!enrollDate){ toast('입학일을 선택하세요','err'); return; }
  if(db.semesterRecords.some(r=>{const s=getStudent(r.studentId);return s&&s.code===code&&r.branchId===branchId&&r.semesterId===semId;})){
    toast('이미 등록된 회원코드입니다','err'); return; }

  // 반 결정: 드롭다운에서 기존 반 선택 or 새 반 직접 입력
  const csel = el('nsClassSelect');
  const pick = csel ? csel.value : '';
  let className, classLbl, teacher;
  if(pick && pick!=='__new__'){
    // 기존 반 선택 → 그 반의 정확한 className/라벨/담임 사용
    const ref = activeRecordsOf(branchId, semId).find(r=>r.className===pick);
    className = pick;
    classLbl = (ref && ref.classLabel) || classLabel(pick) || pick;
    teacher = (ref && ref.teacher) || '미배정';
  } else if(pick==='__new__'){
    const inClass = el('nsClass').value.trim();
    if(!inClass){ toast('새 반명을 입력하세요','err'); return; }
    className = inClass;
    classLbl = classLabel(inClass) || inClass;
    teacher = el('nsTeacher').value.trim() || '미배정';
  } else {
    toast('반을 선택하세요','err'); return;
  }

  let stu=db.students.find(s=>s.code===code);
  if(!stu){ stu={id:uid('st'),code,name,school:el('nsSchool').value.trim(),grade:el('nsGrade').value.trim()};
    db.students.push(stu); }
  db.semesterRecords.push({id:uid('rec'),studentId:stu.id,branchId,semesterId:semId,
    className,classLabel:classLbl,teacher,
    note:'신규생',targetType:'HCMC',status:'active',origin:'new',enrollDate});
  db.studentMovements.push({id:uid('mv'),studentId:stu.id,branchId,semesterId:semId,type:'new',date:enrollDate,memo:'수동 등록'});
  saveDB(); toast(`${name} 신규생 등록 완료`,'ok'); render();
}

/* 퇴원 처리 — 이름/코드 검색 결과 렌더 (동명이인 구분 위해 코드·반·담임 표시) */
function renderWdResults(){
  const branchId=session.branchId, semId=state.semId;
  const q = (el('wdSearch').value||'').trim().toLowerCase();
  const box = el('wdResults');
  if(!q){ box.innerHTML=''; return; }
  const matches = activeRecordsOf(branchId, semId).filter(r=>{
    const s=getStudent(r.studentId); if(!s) return false;
    return s.name.toLowerCase().includes(q) || (s.code||'').toLowerCase().includes(q);
  }).sort((a,b)=>{
    const sa=getStudent(a.studentId), sb=getStudent(b.studentId);
    return (sa?sa.name:'').localeCompare(sb?sb.name:'','ko');
  });
  if(matches.length===0){
    box.innerHTML = `<div class="wd-empty">검색 결과가 없습니다</div>`; return;
  }
  box.innerHTML = matches.slice(0,30).map(r=>{
    const s=getStudent(r.studentId);
    return `<div class="wd-item" onclick="pickWdStudent('${r.id}')">
      <div class="wd-main">
        <span class="wd-name">${esc(s.name)}</span>
        <span class="code-chip">${esc(s.code)}</span>
      </div>
      <div class="wd-meta">${esc(r.classLabel||r.className)} · ${esc(r.teacher)} 담임 · ${esc(s.school||'')} ${esc(s.grade||'')}${s.grade?'학년':''}</div>
    </div>`;
  }).join('');
}
/* 검색 결과에서 학생 선택 → 확정 표시 */
function pickWdStudent(recId){
  const rec=db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s=getStudent(rec.studentId);
  el('wdSelect').value = recId;
  el('wdResults').innerHTML = '';
  el('wdSearch').value = s.name;
  const picked = el('wdPicked');
  picked.style.display='block';
  picked.innerHTML = `<div class="wd-picked-card">
    <div>
      <div class="wd-picked-name">선택됨: <b>${esc(s.name)}</b> <span class="code-chip">${esc(s.code)}</span></div>
      <div class="wd-meta">${esc(rec.classLabel||rec.className)} · ${esc(rec.teacher)} 담임</div>
    </div>
    <button class="btn sm" onclick="clearWdPick()">취소</button>
  </div>`;
}
function clearWdPick(){
  el('wdSelect').value='';
  el('wdPicked').style.display='none';
  el('wdPicked').innerHTML='';
  el('wdSearch').value='';
  el('wdResults').innerHTML='';
}
function withdrawStudent(){
  const recId=el('wdSelect').value;
  if(!recId){ toast('학생을 검색해서 선택하세요','err'); return; }
  const rec=db.semesterRecords.find(r=>r.id===recId);
  if(!rec){ toast('학생을 다시 선택하세요','err'); return; }
  rec.status='withdraw';
  const stu=getStudent(rec.studentId);
  db.studentMovements.push({id:uid('mv'),studentId:rec.studentId,branchId:rec.branchId,semesterId:rec.semesterId,
    type:'withdraw',date:today(),memo:el('wdMemo').value.trim()||'퇴원 처리'});
  saveDB(); toast(`${stu.name} 퇴원 처리 완료`,'ok'); render();
}

/* ============================================================================
   17. 관리자 — 분원 계정 관리
   ============================================================================ */
function renderAccounts(){
  crumbs([{label:'분원 계정 관리'}]);
  const branchUsers = db.users.filter(u=>u.role==='branch');
  el('content').innerHTML = `
    <div class="page-head"><h2>분원 계정 관리</h2>
      <div class="sub">분원 계정을 생성하면 해당 계정은 자기 분원 데이터만 보고 업로드할 수 있습니다.</div></div>
    <div class="panel" style="margin-bottom:16px">
      <h3 style="font-size:14.5px;font-weight:650;margin-bottom:14px">새 분원 계정 생성</h3>
      <div class="acct-add">
        <div class="field"><label>분원</label>
          <select id="acBranch">
            <option value="">분원 선택…</option>
            ${db.branches.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}
            <option value="__new__">+ 새 분원 추가</option>
          </select></div>
        <div class="field" id="acNewBranchWrap" style="display:none"><label>새 분원명</label>
          <input id="acNewBranch" placeholder="예: 광교분원"></div>
        <div class="field"><label>아이디</label><input id="acUser" placeholder="영문 아이디"></div>
        <div class="field"><label>비밀번호</label><input id="acPw" placeholder="비밀번호"></div>
        <button class="btn primary" onclick="createBranchAccount()">계정 생성</button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-scroll"><table class="grid">
        <thead><tr><th>분원</th><th>아이디</th><th>비밀번호</th><th>학생 수</th><th class="cc">관리</th></tr></thead>
        <tbody>
          ${branchUsers.map(u=>{
            const b=getBranch(u.branchId);
            const cnt=db.semesterRecords.filter(r=>r.branchId===u.branchId && r.semesterId===state.semId && r.status==='active').length;
            return `<tr>
              <td><b>${esc(b?b.name:'(분원없음)')}</b></td>
              <td><span class="code-chip">${esc(u.username)}</span></td>
              <td style="color:var(--ink-3)">${esc(u.password)}</td>
              <td class="num">${cnt}명</td>
              <td class="cc"><button class="btn sm" style="color:var(--neg)" onclick="deleteAccount('${u.id}')">삭제</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>`;
  el('acBranch').onchange = e=>{
    el('acNewBranchWrap').style.display = e.target.value==='__new__'?'block':'none';
  };
}
function createBranchAccount(){
  const bsel=el('acBranch').value;
  const user=el('acUser').value.trim(), pw=el('acPw').value.trim();
  if(!bsel){ toast('분원을 선택하세요','err'); return; }
  if(!user||!pw){ toast('아이디와 비밀번호를 입력하세요','err'); return; }
  if(db.users.some(u=>u.username===user)){ toast('이미 존재하는 아이디입니다','err'); return; }
  let branchId=bsel;
  if(bsel==='__new__'){
    const nm=el('acNewBranch').value.trim();
    if(!nm){ toast('새 분원명을 입력하세요','err'); return; }
    branchId=uid('br'); db.branches.push({id:branchId,name:nm});
  }
  db.users.push({id:uid('u'),username:user,password:pw,role:'branch',branchId});
  saveDB(); toast('분원 계정 생성 완료','ok'); render();
}
function deleteAccount(uid){
  const u=db.users.find(x=>x.id===uid);
  openConfirm('계정 삭제', `${u.username} 계정을 삭제할까요? 분원 데이터(학생·상담이력)는 보존됩니다.`, ()=>{
    db.users=db.users.filter(x=>x.id!==uid); saveDB(); closeModal(); toast('계정 삭제됨','ok'); render();
  });
}

/* ============================================================================
   18. 모달 유틸
   ============================================================================ */
function openModal(html){ el('modalBox').innerHTML=html; el('modalOverlay').classList.add('open'); }
function closeModal(){ el('modalOverlay').classList.remove('open'); }
el('modalOverlay').addEventListener('click', e=>{ if(e.target===el('modalOverlay')) closeModal(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

function openConfirm(title, msg, onYes, opts={}){
  const danger = opts.danger!==false; // 삭제류 기본 빨강
  const yesLabel = opts.yesLabel || '삭제';
  openModal(`
    <div class="modal-head"><div><h3>${esc(title)}</h3></div>
      <button class="modal-x" onclick="closeModal()">×</button></div>
    <div class="modal-body"><p style="font-size:13.5px;color:var(--ink-2);line-height:1.65;white-space:pre-line">${esc(msg)}</p></div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">취소</button>
      <button class="btn ${danger?'':'primary'}" id="confirmYes"
        ${danger?'style="background:var(--neg);color:#fff;border-color:var(--neg)"':''}>${esc(yesLabel)}</button>
    </div>`);
  el('confirmYes').onclick = onYes;
}
function confirmReset(){
  openConfirm('전체 데이터 초기화','업로드한 전체명단·상담이력과 신규/퇴원 기록이 모두 삭제되고 빈 상태로 돌아갑니다. 분원 계정은 유지됩니다. 되돌릴 수 없습니다.',async ()=>{
    await resetDB(); closeModal(); toast('초기화 완료','ok');
    const cur=currentSemester(); state.semId = db.semesters.some(s=>s.id===cur.id)?cur.id:(db.semesters[0]&&db.semesters[0].id); buildShell(); go('data');
  }, {yesLabel:'전체 초기화'});
}

/* ============================================================================
   19. 부트스트랩
   ============================================================================ */
async function init(){
  el('loginBtn').onclick = doLogin;
  el('logoutBtn').onclick = logout;
  ['loginId','loginPw'].forEach(id=> el(id).addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); }));
  // 로그인 버튼 잠시 비활성 + 안내
  const lb = el('loginBtn');
  lb.disabled = true; lb.textContent = '서버 연결 중…';
  try{
    await loadDB();
    loadSession();
    lb.disabled = false; lb.textContent = '로그인';
    if(session){ enterApp(); } else { showLogin(); }
  }catch(e){
    console.error(e);
    lb.disabled = false; lb.textContent = '로그인';
    el('loginErr').textContent = '서버 연결에 실패했습니다. 새로고침하거나 인터넷 연결을 확인하세요.';
    showLogin();
  }
}
init();
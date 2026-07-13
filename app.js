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
/* 학기 드롭다운에서 '다음 학기 추가' 선택 시 — 가장 최신 학기의 다음 학기를 만들어 전환 */
function addNextSemester(){
  // db.semesters 중 가장 최신(rank 큰) 학기를 기준으로 다음 학기 계산
  const rank = id=>{ const m=String(id).match(/sem_(\d+)_(\w+)/); if(!m) return 0;
    const o={spring:0,summer:1,fall:2,winter:3}; return parseInt(m[1],10)*10+(o[m[2]]||0); };
  const latest = [...db.semesters].sort((a,b)=>rank(b.id)-rank(a.id))[0];
  let base;
  if(latest){ const m=String(latest.id).match(/sem_(\d+)_(\w+)/);
    base={year:parseInt(m[1],10), key:m[2]}; }
  else base=currentSemester();
  const next = semesterForward(base, 1);
  if(db.semesters.some(s=>s.id===next.id)){
    state.semId = next.id;  // 이미 있으면 그냥 전환
    buildShell(); render(); return;
  }
  db.semesters.push({ id:next.id, name:next.name });
  // 최신순 재정렬
  const rk = id=>{ const m=String(id).match(/sem_(\d+)_(\w+)/); if(!m) return 0;
    const o={spring:0,summer:1,fall:2,winter:3}; return parseInt(m[1],10)*10+(o[m[2]]||0); };
  db.semesters.sort((a,b)=>rk(b.id)-rk(a.id));
  state.semId = next.id;
  saveDB();
  buildShell();
  toast(`${next.name} 추가됨 — 이제 이 학기 명단을 업로드하세요`,'ok');
  render();
}

/* 학기 삭제 — 분원 계정 전용.
   · 데이터 있으면: 자기 분원의 그 학기 데이터만 삭제 (학기는 유지)
   · 빈 학기면: 잘못 만든 거라 보고 학기 자체를 목록에서 제거 (현재 진행 학기는 제외) */
function confirmDeleteSemester(){
  const semId = state.semId;
  const sem = db.semesters.find(s=>s.id===semId);
  if(!sem) return;
  const branchId = session.branchId;
  if(!branchId){ toast('분원 계정만 삭제할 수 있습니다','err'); return; }
  const b = getBranch(branchId);
// 지난 학기는 데이터 유무와 상관없이 삭제 잠금 (빈 미래 학기 제거는 허용)
  if(isPastSemester(semId)){ lockedPastToast(); return; }

  const stuCnt = (db.semesterRecords||[]).filter(r=>r.semesterId===semId && r.branchId===branchId).length;
  const hisCnt = (db.counselingHistories||[]).filter(c=>c.semesterId===semId && c.branchId===branchId).length;

  // 빈 학기(이 분원 데이터 없음) → 학기 목록에서 제거 시도
  if(stuCnt===0 && hisCnt===0){
    const cur = currentSemester();
    if(semId===cur.id){ toast('현재 진행 중인 학기는 목록에서 제거할 수 없습니다','err'); return; }
    // 다른 분원이 이 학기에 데이터를 갖고 있으면 목록에서 빼면 안 됨
    const usedByOthers = (db.semesterRecords||[]).some(r=>r.semesterId===semId)
      || (db.counselingHistories||[]).some(c=>c.semesterId===semId);
    if(usedByOthers){ toast('다른 분원이 이 학기 데이터를 사용 중이라 제거할 수 없습니다','err'); return; }
    openConfirm('학기 제거', `「${sem.name}」을(를) 목록에서 제거할까요?\n\n이 학기엔 데이터가 없습니다 (잘못 추가한 학기). 목록에서 사라집니다.`, ()=>{
      db.semesters = db.semesters.filter(s=>s.id!==semId);
      state.semId = db.semesters.some(s=>s.id===cur.id) ? cur.id : (db.semesters[0]?db.semesters[0].id:null);
      showSaving('학기 제거 중…');
      saveDB().then(ok=>{ hideSaving(); closeModal();
        toast(ok?`${sem.name} 제거됨`:'저장 실패, 다시 시도하세요', ok?'ok':'err');
        buildShell(); render();
      });
    }, {yesLabel:'목록에서 제거'});
    return;
  }

  // 데이터 있는 학기 → 자기 분원 데이터만 삭제
  const msg = `정말 「${b?b.name:''} · ${sem.name}」 데이터를 삭제할까요?\n\n이 분원의 이 학기 학생 ${stuCnt}명, 상담이력 ${hisCnt}건, 신규/퇴원·담임변경 기록이 모두 사라집니다. 다른 분원과 다른 학기는 영향받지 않습니다.\n\n복구할 수 없습니다.`;
  openConfirm('학기 데이터 삭제', msg, ()=>{
    const keep = (arr)=> (arr||[]).filter(x=> !(x.semesterId===semId && x.branchId===branchId));
    db.semesterRecords     = keep(db.semesterRecords);
    db.counselingHistories = keep(db.counselingHistories);
    db.studentMovements    = keep(db.studentMovements);
    db.uploadBatches       = keep(db.uploadBatches);
    db.teacherChanges      = keep(db.teacherChanges);
    showSaving('학기 데이터 삭제 중…');
    saveDB().then(ok=>{
      hideSaving(); closeModal();
      toast(ok?`${sem.name} 데이터 삭제 완료`:'저장 실패, 다시 시도하세요', ok?'ok':'err');
      render();
    });
  }, {yesLabel:'영구 삭제'});
}
/* 현재 학기에서 n학기 전 */
function semesterBack(base, n){
  const order = ['spring','summer','fall','winter']; // 봄→여름→가을→겨울
  let year = base.year, idx = order.indexOf(base.key);
  for(let i=0;i<n;i++){ idx-=1; if(idx<0){ idx=order.length-1; year-=1; } }
  const key = order[idx];
  const label = SEASONS.find(s=>s.key===key).label;
  return { id:`sem_${year}_${key}`, name:`${year}년 ${label}학기`, year, key };
}
/* 현재 학기에서 n학기 후 */
function semesterForward(base, n){
  const order = ['spring','summer','fall','winter'];
  let year = base.year, idx = order.indexOf(base.key);
  for(let i=0;i<n;i++){ idx+=1; if(idx>=order.length){ idx=0; year+=1; } }
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
  // 실제 데이터(학생 레코드/상담)가 있는 과거 학기 + 현재 + 미래(수동 추가) 학기 유지
  const curRank = (()=>{ const o={spring:0,summer:1,fall:2,winter:3}; return cur.year*10+(o[cur.key]||0); })();
  const rankOf = id=>{ const m=String(id).match(/sem_(\d+)_(\w+)/); if(!m) return 0;
    const o={spring:0,summer:1,fall:2,winter:3}; return parseInt(m[1],10)*10+(o[m[2]]||0); };
  const usedSemIds = new Set([
    cur.id,
    ...((db.semesterRecords||[]).map(r=>r.semesterId)),
    ...((db.counselingHistories||[]).map(c=>c.semesterId)),
  ]);
  db.semesters = db.semesters.filter(s=> usedSemIds.has(s.id) || rankOf(s.id) > curRank);
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
{ key:'users', table:'users', toRow:u=>({id:u.id,username:u.username,password:u.password,role:u.role,branch_id:u.branchId,teacher_name:u.teacherName||null}),
    fromRow:r=>({id:r.id,username:r.username,password:r.password,role:r.role,branchId:r.branch_id,teacherName:r.teacher_name}) },
  { key:'semesters',          table:'semesters',            toRow:s=>({id:s.id,name:s.name}),
    fromRow:r=>({id:r.id,name:r.name}) },
  { key:'students',           table:'students',             toRow:s=>({id:s.id,code:s.code,name:s.name,school:s.school,grade:s.grade}),
    fromRow:r=>({id:r.id,code:r.code,name:r.name,school:r.school,grade:r.grade}) },
{ key:'semesterRecords',    table:'semester_records',     toRow:r=>({id:r.id,student_id:r.studentId,branch_id:r.branchId,semester_id:r.semesterId,class_name:r.className,class_label:r.classLabel,teacher:r.teacher,note:r.note,target_type:r.targetType,status:r.status,origin:r.origin,enroll_date:r.enrollDate,withdraw_date:r.withdrawDate,transfer:!!r.transfer,transfer_in:!!r.transferIn,transfer_to:r.transferTo||null,kind:r.kind||'regular',withdraw_reason:r.withdrawReason||null,withdraw_memo:r.withdrawMemo||null}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,className:r.class_name,classLabel:r.class_label,teacher:r.teacher,note:r.note,targetType:r.target_type,status:r.status,origin:r.origin,enrollDate:r.enroll_date,withdrawDate:r.withdraw_date,transfer:!!r.transfer,transferIn:!!r.transfer_in,transferTo:r.transfer_to,kind:r.kind||'regular',withdrawReason:r.withdraw_reason||null,withdrawMemo:r.withdraw_memo||null}) },
  { key:'counselingHistories',table:'counseling_histories', toRow:c=>({id:c.id,student_id:c.studentId,branch_id:c.branchId,semester_id:c.semesterId,date:c.date,type:c.type,content:c.content,counselor:c.counselor,batch_id:c.batchId,mistag:!!c.mistag}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,date:r.date,type:r.type,content:r.content,counselor:r.counselor,batchId:r.batch_id,mistag:!!r.mistag}) },
  { key:'studentMovements',   table:'student_movements',    toRow:m=>({id:m.id,student_id:m.studentId,branch_id:m.branchId,semester_id:m.semesterId,type:m.type,date:m.date,memo:m.memo}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,type:r.type,date:r.date,memo:r.memo}) },
  { key:'uploadBatches',      table:'upload_batches',       toRow:b=>({id:b.id,branch_id:b.branchId,semester_id:b.semesterId,kind:b.kind,file_name:b.fileName,uploaded_at:b.uploadedAt,added:b.added,dup:b.dup,skip:b.skip}),
    fromRow:r=>({id:r.id,branchId:r.branch_id,semesterId:r.semester_id,kind:r.kind,fileName:r.file_name,uploadedAt:r.uploaded_at,added:r.added,dup:r.dup,skip:r.skip}) },
  { key:'teacherChanges',     table:'teacher_changes',      toRow:c=>({id:c.id,branch_id:c.branchId,semester_id:c.semesterId,class_name:c.className,from_teacher:c.fromTeacher,to_teacher:c.toTeacher,date:c.date}),
    fromRow:r=>({id:r.id,branchId:r.branch_id,semesterId:r.semester_id,className:r.class_name,fromTeacher:r.from_teacher,toTeacher:r.to_teacher,date:r.date}) },
    { key:'segments', table:'segments', toRow:s=>({id:s.id,branch_id:s.branchId,semester_id:s.semesterId,stage:s.stage,sec1:s.sec1,sec2:s.sec2,sec3:s.sec3,sec4:s.sec4,updated_at:s.updatedAt}),
    fromRow:r=>({id:r.id,branchId:r.branch_id,semesterId:r.semester_id,stage:r.stage,sec1:r.sec1,sec2:r.sec2,sec3:r.sec3,sec4:r.sec4,updatedAt:r.updated_at}) },
    { key:'mcExemptions', table:'mc_exemptions', toRow:e=>({id:e.id,student_id:e.studentId,branch_id:e.branchId,semester_id:e.semesterId,stage:e.stage}),
    fromRow:r=>({id:r.id,studentId:r.student_id,branchId:r.branch_id,semesterId:r.semester_id,stage:r.stage}) },
];

function blankDB(){
  return { users:[], branches:[], semesters:[], students:[],
           semesterRecords:[], counselingHistories:[], studentMovements:[],
           uploadBatches:[], teacherChanges:[], segments:[], mcExemptions:[] };
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

/* 서버에서 전체 데이터 읽기 → 메모리 db.
   Supabase는 한 요청에 최대 1000행만 주므로, range()로 끝까지 페이지를 넘기며 전부 가져옴. */
async function loadDB(){
  initSupabase();
  db = blankDB();
  const PAGE = 1000;
  for(const t of TABLES){
    let all = [];
    let from = 0;
    while(true){
      const { data, error } = await sb.from(t.table).select('*').range(from, from+PAGE-1);
      if(error){ console.error('load fail', t.table, error); throw error; }
      const chunk = data || [];
      all = all.concat(chunk);
      if(chunk.length < PAGE) break;   // 마지막 페이지 (1000개 미만이면 끝)
      from += PAGE;
    }
    db[t.key] = all.map(t.fromRow);
  }
  // 기존 데이터 보정: classLabel이 원본 형식(대괄호 포함)이면 깔끔한 라벨로 변환
  (db.semesterRecords||[]).forEach(r=>{
    if(r.classLabel && /^\s*\[/.test(r.classLabel)){
      r.classLabel = classLabel(r.classLabel) || r.classLabel;
    }
  });
 // 기존 퇴원생 보정: studentMovements.memo → rec.withdrawMemo 로 1회 이관
  (db.semesterRecords||[]).forEach(r=>{
    if(r.status!=='withdraw') return;
    if(r.withdrawMemo!=null) return;
    const mv = (db.studentMovements||[]).find(m=>m.studentId===r.studentId && m.branchId===r.branchId && m.semesterId===r.semesterId && m.type==='withdraw');
    let memo = (mv && mv.memo) || '';
    memo = memo.replace(/^\[[^\]]*\]\s*/, '').trim();   // [전출→…] / [사유] 접두사 제거
    if(memo==='퇴원 처리') memo='';
    r.withdrawMemo = memo;
  });

  // 학기 자동 보강 (현재+직전 학기). 새로 추가된 학기는 서버에도 저장.
  ensureSemesters();
  dbSnapshot = JSON.parse(JSON.stringify(db));  // 기준 스냅샷
  await saveDB(); // ensureSemesters로 늘어난 학기 등 반영
}

/* 메모리 db를 서버에 동기화 — 직전 스냅샷과 비교해 바뀐 행만 upsert + 삭제된 행 delete.
   대량 데이터는 Supabase 요청 한도를 넘지 않게 잘게 나눠서 보냄(배치). */
async function saveDB(){
  if(!sb){ try{ initSupabase(); }catch(e){ console.error(e); return false; } }
  const CHUNK = 200;  // 한 번에 보낼 최대 행 수
  let failed = false;
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
      // upsert 배치 처리
      for(let i=0;i<ups.length;i+=CHUNK){
        const slice = ups.slice(i, i+CHUNK);
        const { error } = await sb.from(t.table).upsert(slice);
        if(error){ console.error('upsert fail', t.table, error); failed = true; }
      }
      // delete 배치 처리
      for(let i=0;i<delIds.length;i+=CHUNK){
        const slice = delIds.slice(i, i+CHUNK);
        const { error } = await sb.from(t.table).delete().in('id', slice);
        if(error){ console.error('delete fail', t.table, error); failed = true; }
      }
    }
    if(failed){
      toast('일부 데이터 저장에 실패했습니다. 새로고침 후 다시 시도하세요.','err');
      return false;  // 스냅샷 갱신 안 함 → 다음 저장에서 재시도
    }
    dbSnapshot = JSON.parse(JSON.stringify(db));  // 동기화 완료 → 스냅샷 갱신
    return true;
  }catch(e){ console.error('saveDB error', e); toast('서버 저장 중 오류가 발생했습니다','err'); return false; }
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
/* 지난 학기인지 — 보고 있는 학기가 오늘 기준 현재 학기보다 과거면 true.
   과거 학기는 삭제·전체명단 업로드 잠금 (상담이력 추가 업로드는 허용).
   미래 학기(잘못 만든 다음 학기)는 과거가 아니므로 잠그지 않음. */
function semRank(id){
  const m=String(id).match(/sem_(\d+)_(\w+)/); if(!m) return 0;
  const o={spring:0,summer:1,fall:2,winter:3}; return parseInt(m[1],10)*10+(o[m[2]]||0);
}
function isPastSemester(semId){
  const cur = currentSemester();
  return semRank(semId) < semRank(cur.id);
}
/* 지난 학기 보호 안내 팝업 */
function lockedPastToast(){
  openConfirm('지난 학기는 잠겨 있습니다',
    '이미 마감된 지난 학기 데이터입니다.\n\n삭제와 전체명단 업로드는 막아두었습니다. (실수로 지난 장부가 날아가는 걸 방지)\n\n퇴원 처리·상담이력 추가 업로드는 현재 학기로 전환하지 않아도 가능합니다.',
    ()=>{ closeModal(); }, {yesLabel:'확인', danger:false});
}

/* 한 학기 한 분원의 학기레코드 — 정규반(regular)만. 내신반(exam)은 인원 집계 전부 제외 */
function recordsOf(branchId, semId){
  return db.semesterRecords.filter(r=>r.branchId===branchId && r.semesterId===semId && (r.kind||'regular')!=='exam');
}
function activeRecordsOf(branchId, semId){
  return recordsOf(branchId,semId).filter(r=>r.status==='active');
}
/* 내신반(exam)만 — 표시용. 인원에 더하지 않고 "현재 내신반 N명"만 보여줄 때 사용 */
function examRecordsOf(branchId, semId){
  return db.semesterRecords.filter(r=>r.branchId===branchId && r.semesterId===semId && (r.kind||'regular')==='exam' && r.status==='active');
}
/* 상담률 계산용 — 정규반 active + 내신반 active 합친 레코드.
   인원/퇴원 집계엔 쓰지 말 것(그건 recordsOf/activeRecordsOf만). 상담률(calcRates) 전용. */
function rateRecordsOf(branchId, semId){
  // 상담률 분모엔 재원생 + 퇴원생(정규반) 모두 포함.
  // 퇴원생은 isTarget이 '퇴원월 이후 회차'를 알아서 제외하므로,
  // 퇴원 전에 했어야 할 회차의 펑크는 정직하게 분모에 잡힌다.
  return recordsOf(branchId, semId).concat(examRecordsOf(branchId, semId));
}
/* 특정 담임의 정규+내신 active 합본 (상담률용) */
function rateRecordsOfTeacher(branchId, semId, teacher){
  return rateRecordsOf(branchId, semId).filter(r=>r.teacher===teacher);
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

/* 상담 회차와 실제 상담 날짜를 비교해 어느 학기 상담인지 판정.
   - HC1/HC2: 입학월 기준. (입학월 전달) ~ (학기 마지막 달) 사이면 인정.
              입학일 없으면 학기 첫 달 신규로 보고 첫 달의 전달부터 인정.
              그보다 전이면 이전 학기 상담 → 'prev'.
   - MC1~3: 기존대로 회차-월 비교. */
function stageTimingCheck(type, dateStr, semId, enrollDate){
  const months = semesterMonths(semId);            // 예: [6,7,8]
  const m = String(dateStr||'').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(!m) return 'ok';                              // 날짜 파싱 불가 → 인정
  const cMonth = parseInt(m[2],10);

  if(type==='HC1' || type==='HC2'){
    // 입학월: 있으면 그 월, 없으면 학기 첫 달(시작신규생)
    const em = String(enrollDate||'').match(/\d{4}-(\d{1,2})/);
    const enrollM = em ? parseInt(em[1],10) : months[0];
    // 인정 시작월 = 입학월의 전달 (단, 학기 첫 달보다 앞서면 학기 첫 달의 전달로 맞춤)
    const baseM = Math.max(enrollM, months[0]);    // 입학월이 학기 첫 달보다 이르면 첫 달 기준
    const prevMonth = baseM===1 ? 12 : baseM-1;    // 그 달의 전달
    // 인정 범위: 전달 + 학기 3개월
    const okMonths = [prevMonth, ...months];
    return okMonths.includes(cMonth) ? 'ok' : 'prev';
  }

  const stageIdx = { MC1:0, MC2:1, MC3:2 }[type];  // 회차의 정상 '몇 번째 달'
  if(stageIdx==null) return 'ok';
  const slot = months.indexOf(cMonth);             // 상담월이 이 학기의 몇 번째 달인지
  if(slot===-1) return 'prev';                     // 학기 3개월에 없음 → 이전학기
const diff = stageIdx - slot;                    // 회차정상위치 - 실제상담위치
  if(diff <= 0) return 'ok';
  if(diff === 1){
    // 월말(25일 이후)에 다음 달 회차를 미리 한 경우는 정상으로 인정
    const day = parseInt(m[3],10);
    if(day >= 25) return 'ok';
    return 'mistag';
  }
  return 'prev';
}
/* 입학일(enrollDate)에서 월 추출. 없으면 null(=학기초부터 다닌 학생) */
function enrollMonth(rec){
  if(!rec.enrollDate) return null;
  const m = String(rec.enrollDate).match(/\d{4}-(\d{1,2})/) || String(rec.enrollDate).match(/\d{4}\.(\d{1,2})/);
  return m ? parseInt(m[1],10) : null;
}
/* 퇴원월 추출 (withdrawDate 우선, 없으면 이동이력) */
function withdrawMonth(rec){
  let d = rec.withdrawDate;
  if(!d){
    const mv = db.studentMovements.find(m=>m.studentId===rec.studentId && m.branchId===rec.branchId && m.semesterId===rec.semesterId && m.type==='withdraw');
    d = mv && mv.date;
  }
  if(!d) return null;
  const m = String(d).match(/\d{4}-(\d{1,2})/) || String(d).match(/\d{4}\.(\d{1,2})/);
  return m ? parseInt(m[1],10) : null;
}
/* 변경월을 변경일(cutDay) 기준으로 앞/뒤 구간 실적으로 쪼갬.
   퇴원 책임: 변경일 당일까지(<=cutDay) = 이전 담임(마지막 수업이 이전 담임),
            변경일 다음날부터(>cutDay) = 새 담임.
   신규/등원: 변경일 당일부터(>=cutDay) = 새 담임이 받음. */
function splitMonthForGroup(recs, month, cutDay){
  let monthStart = 0;
  recs.forEach(r=>{
    const em = r.enrollDate ? monthOfDate(r.enrollDate) : null;
    const wm = r.withdrawDate ? monthOfDate(r.withdrawDate) : null;
    const enrolledBefore = (em==null || em<month);
    const notLeftBefore  = (wm==null || wm>=month);
    if(enrolledBefore && notLeftBefore) monthStart++;
  });
  // 신규: 변경일 전(<cutDay)은 이전 담임, 당일부터(>=cutDay)는 새 담임
  const newBefore = recs.filter(r=> monthOfDate(r.enrollDate)===month && dayOfDate(r.enrollDate)<cutDay).length;
  const newAfter  = recs.filter(r=> monthOfDate(r.enrollDate)===month && dayOfDate(r.enrollDate)>=cutDay).length;
  // 퇴원: 변경일 당일까지(<=cutDay)는 이전 담임, 다음날부터(>cutDay)는 새 담임
  const wdBefore  = recs.filter(r=> monthOfDate(r.withdrawDate)===month && dayOfDate(r.withdrawDate)<=cutDay && !r.transfer).length;
  const trBefore  = recs.filter(r=> monthOfDate(r.withdrawDate)===month && dayOfDate(r.withdrawDate)<=cutDay && r.transfer).length;
  const wdAfter   = recs.filter(r=> monthOfDate(r.withdrawDate)===month && dayOfDate(r.withdrawDate)>cutDay && !r.transfer).length;
  const trAfter   = recs.filter(r=> monthOfDate(r.withdrawDate)===month && dayOfDate(r.withdrawDate)>cutDay && r.transfer).length;
  const handover  = monthStart + newBefore - wdBefore - trBefore; // 인계 시점 인원
  return {
    before:{ monthStart, newCnt:newBefore, wd:wdBefore, tr:trBefore },
    after: { monthStart:handover, newCnt:newAfter, wd:wdAfter, tr:trAfter },
  };
}
/* 인원마감 — 한 그룹(강사 또는 레벨)의 월별 월초+신규/퇴원/퇴원율 계산.
   recs: 해당 그룹의 semesterRecords(재원+퇴원 모두 포함). months: [3,4,5] 등.
   첫 달 월초 = 학기초부터 다닌 인원(enrollMonth==null).
   이후 달 월초 = 전달(월초+신규) − 전달 퇴원.
   월별 퇴원율 = 그 달 퇴원 ÷ (월초+신규). 평균퇴원율 = 월별 퇴원율의 단순평균. */
function monthlyClosing(recs, months, activeMonths, splits){
  // activeMonths: 담당 월 Set (그 외 빈칸). splits: 변경월 날짜쪼갬 정보 배열.
  const startOfSem = recs.filter(r=> enrollMonth(r)==null).length;
  const splitByMonth = new Map();
  (splits||[]).forEach(sp=> splitByMonth.set(sp.month, sp));
  let carry = 0;
  const cells = [];
  const rates = [];
  months.forEach((m, idx)=>{
    const active = !activeMonths || activeMonths.has(m);
    const sp = splitByMonth.get(m);
    let monthStart = idx===0 ? startOfSem : carry;
let newThis, tiThis=0, wdThis, trThis;
    if(sp){
      // 변경월: 날짜로 쪼갬
      const split = splitMonthForGroup(recs, m, sp.cutDay);
      const part = sp.side==='before' ? split.before : split.after;
      monthStart = part.monthStart;
      newThis = part.newCnt;
      wdThis = part.wd;
      trThis = part.tr;
} else {
      newThis = recs.filter(r=> enrollMonth(r)===m && !r.transferIn).length;
      tiThis  = recs.filter(r=> enrollMonth(r)===m && r.transferIn).length;
      wdThis  = recs.filter(r=> withdrawMonth(r)===m && !r.transfer).length;
      trThis  = recs.filter(r=> withdrawMonth(r)===m && r.transfer).length;
    }
const baseNew = monthStart + newThis + tiThis;
    const rate = baseNew>0 ? (wdThis/baseNew*100) : 0;
    if(active){
      cells.push({ month:m, monthStart, newThis, transferIn:tiThis, baseNew, withdraw:wdThis, transfer:trThis, rate, blank:false });
      if(baseNew>0) rates.push(rate);
    } else {
      cells.push({ month:m, monthStart:0, newThis:0, transferIn:0, baseNew:0, withdraw:0, transfer:0, rate:0, blank:true });
    }
    carry = baseNew - wdThis - trThis;
  });
 const totWithdraw = cells.reduce((a,c)=>a+(c.blank?0:c.withdraw),0);
  const totTransfer = cells.reduce((a,c)=>a+(c.blank?0:c.transfer),0);
  const totNew = cells.reduce((a,c)=>a+(c.blank?0:c.newThis),0);
  const totTransferIn = cells.reduce((a,c)=>a+(c.blank?0:c.transferIn),0);
  const avgRate = rates.length ? rates.reduce((a,c)=>a+c,0)/rates.length : 0;
  return { cells, totWithdraw, totTransfer, totNew, totTransferIn, avgRate };
}
/* 일별 집계 — 한 달의 날짜별 인원 추적 (퇴원율 집계표용).
   월초인원 = 이 달 전부터 다니고 이 달엔 아직 안 나간 학생.
   각 날짜: 신입(그날)/신입누계/기준학생수/퇴원(그날, 전출제외)/퇴원누계/퇴원율. */
function daysInMonth(year, month){ return new Date(year, month, 0).getDate(); }
function dayOfDate(s){ const m=String(s||'').match(/\d{4}-\d{1,2}-(\d{1,2})/); return m?parseInt(m[1],10):null; }
function monthOfDate(s){ const m=String(s||'').match(/\d{4}-(\d{1,2})-\d{1,2}/); return m?parseInt(m[1],10):null; }
function dailyClosing(recs, year, month){
  const days = daysInMonth(year, month);
  let startCount = 0;
  recs.forEach(r=>{
    const em = r.enrollDate ? monthOfDate(r.enrollDate) : null;
    const wm = r.withdrawDate ? monthOfDate(r.withdrawDate) : null;
    const enrolledBefore = (em==null || em<month);
    const notLeftBefore  = (wm==null || wm>=month);
    if(enrolledBefore && notLeftBefore) startCount++;
  });
  let running = startCount, newAcc = 0, wdAcc = 0;
  const rows = [];
  for(let d=1; d<=days; d++){
    const newToday = recs.filter(r=> monthOfDate(r.enrollDate)===month && dayOfDate(r.enrollDate)===d).length;
    const wdToday  = recs.filter(r=> monthOfDate(r.withdrawDate)===month && dayOfDate(r.withdrawDate)===d && !r.transfer).length;
    const trToday  = recs.filter(r=> monthOfDate(r.withdrawDate)===month && dayOfDate(r.withdrawDate)===d && r.transfer).length;
    running += newToday;
    const base = running;
    running -= (wdToday + trToday);
    newAcc += newToday; wdAcc += wdToday;
    rows.push({ d, newToday, newAcc, base, wdToday, trToday, wdAcc, rate: base>0?(wdToday/base*100):0 });
  }
  return { startCount, rows, endCount:running };
}
/* 학생이 특정 단계 상담 대상인지 — 입학월 기준
   HC1/HC2: 신규·복귀생이면 입학월 상관없이 대상
   MC1/2/3: 입학월 이후의 MC만 대상 (예: 7월 입학 → MC1 제외, MC2·MC3 대상) */
function isTarget(rec, stage, semId){
  const sid = semId || (typeof state!=='undefined'?state.semId:null);
  const isExam = (rec.kind||'regular')==='exam';

  // 내신반: 면제로 넘어온 회차(MC)만 대상. HC와 면제 안 된 MC는 전부 대상 아님.
  if(isExam){
    if(stage==='HC1'||stage==='HC2') return false;
    return isExempt(rec.studentId, rec.branchId, sid, stage);
  }

  // 정규반: 면제된 MC 회차는 대상 아님 (내신반으로 넘어감)
  if(stage!=='HC1' && stage!=='HC2' && isExempt(rec.studentId, rec.branchId, sid, stage)){
    return false;
  }

  // 퇴원생: 퇴원월 이후의 MC 회차는 다닐 때가 아니었으므로 대상 아님.
  // (HC와 퇴원월 이전/같은 달 MC는 정상 판정 → 안 했으면 미완료로 분모에 잡힘)
  if(rec.status==='withdraw' && (stage==='MC1'||stage==='MC2'||stage==='MC3')){
    const wm = withdrawMonth(rec);
    if(wm!=null){
      const ms = semesterMonths(sid);
      const stgMonth = { MC1:ms[0], MC2:ms[1], MC3:ms[2] }[stage];
      const order = m => ms.indexOf(m);
      if(order(stgMonth) > order(wm)) return false;
    }
  }

  if(stage==='HC1'||stage==='HC2') return rec.targetType==='HCMC';
  const months = semesterMonths(sid);
  const mcMonth = { MC1:months[0], MC2:months[1], MC3:months[2] }[stage];
  const em = enrollMonth(rec);
  if(em==null) return true;
  return em <= mcMonth;
}
/* 이 학생의 이 회차가 정규반에서 면제됐는지 (= 내신반으로 넘어갔는지) */
function isExempt(studentId, branchId, semId, stage){
  return (db.mcExemptions||[]).some(e=>
    e.studentId===studentId && e.branchId===branchId &&
    e.semesterId===semId && e.stage===stage);
}
/* 면제 토글 — 분원관리자만. 있으면 해제, 없으면 추가 */
function toggleExemption(studentId, branchId, semId, stage){
  const ex = (db.mcExemptions||[]).find(e=>
    e.studentId===studentId && e.branchId===branchId &&
    e.semesterId===semId && e.stage===stage);
  if(ex){
    db.mcExemptions = db.mcExemptions.filter(e=>e!==ex);
  } else {
    (db.mcExemptions||(db.mcExemptions=[])).push({
      id:uid('ex'), studentId, branchId, semesterId:semId, stage });
  }
  saveDB();
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
  const newRecs      = recs.filter(r=>(r.origin==='new' || r.origin==='return') && !r.transferIn);
  const transferInR  = recs.filter(r=>r.transferIn);
  const withdrawR    = recs.filter(r=>r.status==='withdraw' && !r.transfer);
  const transferR    = recs.filter(r=>r.status==='withdraw' && r.transfer);
  const activeR      = recs.filter(r=>r.status==='active');
 
  const newCnt = newRecs.length;
  const transferIn = transferInR.length;
  const withdraw = withdrawR.length;
  const transfer = transferR.length;
  const active = activeR.length;
  const startCount = total - newCnt - transferIn;
 
  // 학기초 = 재원 + 퇴원 + 전출 - (학기중 들어온 신규/전입)  → 레코드로 직접 계산
  const startR = recs.filter(r=> !((r.origin==='new'||r.origin==='return') && !r.transferIn) && !r.transferIn );
 
  const ca = recs => countChessAce(recs);   // {chess, ace, total}
 
  return {
    start:startCount, newCnt, transferIn, withdraw, transfer, active,
    net:newCnt + transferIn - withdraw - transfer,
    // CHESS/ACE 분리 (각 카드별)
    ca: {
      start:     ca(startR),
      newCnt:    ca(newRecs),
      transferIn:ca(transferInR),
      withdraw:  ca(withdrawR),
      transfer:  ca(transferR),
      active:    ca(activeR),
    }
  };
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
    const rates = calcRates(rateRecordsOfTeacher(branchId, semId, teacher), branchId, semId);
    // 이 담임의 퇴원생 수 (status=withdraw, 같은 담임)
    const withdrawCnt = allRecs.filter(r=>r.teacher===teacher && r.status==='withdraw' && !r.transfer).length;
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
/* 전출-전입 매칭 검증 — 본사용.
   전출(분원A에서 transfer=true, transferTo=B)에 대응하는 전입(분원B에서 transferIn=true)이 있는지 회원코드로 대조.
   반환: { matched:[], unmatchedOut:[전출했는데 도착분원에 전입 없음], unmatchedIn:[전입인데 출발분원에 전출 없음] } */
function transferMatch(semId){
  const recs = db.semesterRecords.filter(r=>r.semesterId===semId && (r.kind||'regular')!=='exam');
  const outs = recs.filter(r=>r.status==='withdraw' && r.transfer);   // 전출들
  const ins  = recs.filter(r=>r.transferIn);                          // 전입들
  const codeOf = r=>{ const s=getStudent(r.studentId); return s?s.code:''; };

  const matched=[], unmatchedOut=[], unmatchedIn=[];
  const usedIn = new Set();

  outs.forEach(o=>{
    const code = codeOf(o);
    // 이 전출에 대응하는 전입: 도착분원(o.transferTo)에서 같은 회원코드로 전입한 레코드
    const match = ins.find(i=> codeOf(i)===code && i.branchId===o.transferTo && !usedIn.has(i.id));
    if(match){ usedIn.add(match.id); matched.push({out:o, in:match, code}); }
    else unmatchedOut.push({out:o, code});
  });
  // 전입인데 대응 전출 없는 것
  ins.forEach(i=>{
    if(usedIn.has(i.id)) return;
    const code = codeOf(i);
    const match = outs.find(o=> codeOf(o)===code && o.transferTo===i.branchId);
    if(!match) unmatchedIn.push({in:i, code});
  });
  return { matched, unmatchedOut, unmatchedIn };
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
const state = { semId:null, route:null, branchSort:'active', teacherSort:'rate_desc', classSort:'rate_desc', allTeacherSort:'rate_desc', rosterTab:'new', closingTab:'teacher', closingMonth:null, rosterTeacher:'', rosterQuery:'', segStage:'MC1' };

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
  clearTimeout(t._tm); t._tm = setTimeout(()=> t.className='', kind==='err'?5000:2800);
}

/* 저장 중 전체 화면 오버레이 — 저장 끝나기 전 새로고침/조작 방지 */
function showSaving(msg){
  let ov = el('savingOverlay');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'savingOverlay';
    ov.innerHTML = `<div class="saving-box"><div class="saving-spin"></div><div class="saving-msg"></div>
      <div class="saving-warn">저장이 끝날 때까지 새로고침하거나 창을 닫지 마세요</div></div>`;
    document.body.appendChild(ov);
  }
  ov.querySelector('.saving-msg').textContent = msg || '저장 중…';
  ov.classList.add('on');
  // 저장 중 페이지 이탈 경고
  window.onbeforeunload = ()=> '저장 중입니다. 지금 나가면 데이터가 사라질 수 있습니다.';
}
function hideSaving(){
  const ov = el('savingOverlay');
  if(ov) ov.classList.remove('on');
  window.onbeforeunload = null;
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
  setSession({ userId:user.id, username:user.username, role:user.role, branchId:user.branchId, teacherName:user.teacherName||null });
  el('loginErr').textContent='';
  el('loginPw').value='';
  enterApp();
}
function logout(){ clearSession(); location.hash=''; showLogin(); }

function showLogin(){ el('appView').style.display='none'; el('loginView').style.display='flex'; }
function enterApp(){
  el('loginView').style.display='none';
  el('appView').style.display='block';
  const cur = currentSemester();
  state.semId = db.semesters.some(s=>s.id===cur.id) ? cur.id : (db.semesters[0] ? db.semesters[0].id : null);
  buildShell();
  if(!location.hash || location.hash==='#'){
   location.hash = session.role==='admin' ? '#/admin' : (session.role==='teacher' ? '#/myclasses' : '#/branch');
  } else { render(); }
}

/* ============================================================================
   6. 앱 셸 (사이드바, 학기 선택)
   ============================================================================ */
function buildShell(){
  const isAdmin = session.role==='admin';
  const isTeacher = session.role==='teacher';
  const branch = isAdmin ? null : getBranch(session.branchId);
  el('sbScope').textContent = isAdmin ? '통합 관리자' : (isTeacher ? (branch?branch.name:'분원')+' 선생님' : (session.role==='assistant' ? (branch?branch.name:'분원')+' 조교' : (branch?branch.name:'분원')));
  el('sbAvatar').textContent = (session.username[0]||'U').toUpperCase();
  el('sbUserName').textContent = isAdmin ? '관리자' : (isTeacher ? (session.teacherName||session.username) : (branch?branch.name:session.username));
  el('sbUserRole').textContent = session.username;

  // 학기 선택 — 분원 계정만 '다음 학기 추가' 옵션 노출 (관리자·선생님은 보기 전용)
  const sel = el('semSelect');
  const isBranch = session.role==='branch';
  sel.innerHTML = db.semesters.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')
    + (isBranch ? `<option value="__add_next__">+ 다음 학기 추가…</option>` : '');
  sel.value = state.semId;
  sel.onchange = ()=>{
    if(sel.value==='__add_next__'){ addNextSemester(); return; }
    state.semId = sel.value; render();
  };
  // 학기 삭제 버튼 — 분원 계정만. 관리자·선생님은 숨김.
  const delBtn = el('semDelBtn');
  if(delBtn){
    delBtn.style.display = isBranch ? 'inline-flex' : 'none';
    delBtn.onclick = ()=> confirmDeleteSemester();
  }

  // 네비
  const nav = el('sbNav');
  const I = {
    dash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    data:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>',
    acct:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    stu:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
    roster:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
    closing:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="13" y="6" width="3" height="11"/></svg>',
    teach:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>',
    seg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };
  if(isAdmin){
    nav.innerHTML = `
      <div class="sb-sect">관리</div>
      <div class="sb-item" data-nav="admin">${I.dash}<span>통합 대시보드</span></div>
      <div class="sb-item" data-nav="roster">${I.roster}<span>신규·퇴원 명단</span></div>
      <div class="sb-item" data-nav="closing">${I.closing}<span>인원마감표</span></div>
      <div class="sb-item" data-nav="accounts">${I.acct}<span>분원 계정 관리</span></div>`;
} else if(isTeacher){
    nav.innerHTML = `
      <div class="sb-sect">선생님</div>
      <div class="sb-item" data-nav="myclasses">${I.dash}<span>내 반 현황</span></div> 
      <div class="sb-item" data-nav="segments">${I.seg}<span>세그먼트</span></div>`; 
  } else if(session.role==='assistant'){
    nav.innerHTML = `
      <div class="sb-sect">조교</div>
     <div class="sb-item" data-nav="start">${I.stu}<span>STaRT 관리</span></div>`;
 } else {
    nav.innerHTML = `
      <div class="sb-sect">분원</div>
      <div class="sb-item" data-nav="branch">${I.dash}<span>Dashboard</span></div>

      <div class="sb-sect">현황</div>
      <div class="sb-item" data-nav="roster">${I.roster}<span>신규·퇴원 명단</span></div>
      <div class="sb-item" data-nav="closing">${I.closing}<span>인원마감표</span></div>

      <div class="sb-sect">학생</div>
      <div class="sb-item" data-nav="students">${I.stu}<span>학생관리</span></div>
      <div class="sb-item" data-nav="start">${I.stu}<span>STaRT 관리</span></div>

      <div class="sb-sect">상담</div>
      <div class="sb-item" data-nav="segments-edit">${I.seg}<span>세그먼트 공지</span></div>

      <div class="sb-sect">설정</div>
      <div class="sb-item" data-nav="teachers">${I.teach}<span>선생님 계정</span></div>
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
   el('content').style.maxWidth = '';
  if(!session){ showLogin(); return; }
  const { parts } = parseRoute();
  const root = parts[0] || (session.role==='admin'?'admin':'branch');

  // 권한 가드
  // admin은 branch/teacher, branch/class (담임·반 상세)는 볼 수 있으나
  // branch 대시보드/데이터관리는 불가. branch는 admin/accounts 불가.
  if(session.role==='admin'){
    if(root==='branch' && parts[1]!=='teacher' && parts[1]!=='class'){ go('admin'); return; }
   if(root==='data'||root==='students'||root==='segments-edit'||root==='teachers'||root==='start'||root==='assistants'){ go('admin'); return; }
  }
  // 선생님: 자기 반 관련 화면만 (myclasses / branch teacher·class 상세)
if(session.role==='teacher'){
    const allowed = (root==='myclasses')
      || (root==='segments')
      || (root==='branch' && (parts[1]==='teacher' || parts[1]==='class'));
    if(!allowed){ go('myclasses'); return; }
  }
  if(session.role==='assistant'){
    if(root!=='start'){ go('start'); return; }
  }
  if(session.role==='branch' && (root==='admin'||root==='accounts')){ go('branch'); return; }
  // 분원 계정은 자기 분원 roster 상세만 (다른 분원 직접 접근 차단)
  if(session.role==='branch' && root==='roster' && parts[1]==='branch' && parts[2] && parts[2]!==session.branchId){ go('roster'); return; }
  if(session.role==='branch' && root==='closing' && parts[1]==='branch' && parts[2] && parts[2]!==session.branchId){ go('closing'); return; }

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
  else if(root==='roster'){
    if(parts[1]==='branch' && parts[2]){ setActiveNav('roster'); renderRosterDetail(parts[2]); }
    else { setActiveNav('roster'); renderRoster(); }
  }
  else if(root==='closing'){
    // 관리자: closing/branch/:id, 분원: closing (자기 분원)
    if(session.role==='admin'){
      if(parts[1]==='branch' && parts[2]){ setActiveNav('closing'); renderClosing(parts[2]); }
      else { setActiveNav('closing'); renderClosingHub(); }
    } else { setActiveNav('closing'); renderClosing(session.branchId); }
  }
  else if(root==='teachers'){ setActiveNav('teachers'); renderTeacherAccounts(); }
else if(root==='segments-edit'){ setActiveNav('segments-edit'); renderSegmentEdit(); }
  else if(root==='segments'){ setActiveNav('segments'); renderSegmentView(); }
  else if(root==='start'){ setActiveNav('start'); renderStart(); }
  else if(root==='myclasses'){ setActiveNav('myclasses'); renderTeacherHome(); }
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
  let badges = '';
  if(opts.ca){
    badges = `<div class="kpi-ca">
      <span class="ca-chess">CHESS ${opts.ca.chess}</span>
      <span class="ca-ace">ACE ${opts.ca.ace}</span>
    </div>`;
  }
  return `<div class="kpi${cls}"><div class="kl">${esc(label)}</div><div class="kv">${v}</div>${badges}</div>`;
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
 let tot = { start:0, newCnt:0, transferIn:0, withdraw:0, transfer:0, active:0, net:0 };
  const CA_KEYS = ['start','newCnt','transferIn','withdraw','transfer','active'];
  const totCa = {};
  CA_KEYS.forEach(k=>{ totCa[k] = {chess:0, ace:0, total:0}; });
const cards = db.branches.map(b=>{
    const hc = headcountClean(b.id, semId);
    const rates = calcRates(rateRecordsOf(b.id, semId), b.id, semId);
tot.start+=hc.start; tot.newCnt+=hc.newCnt; tot.transferIn+=hc.transferIn; tot.withdraw+=hc.withdraw;
    tot.transfer+=hc.transfer; tot.active+=hc.active; tot.net+=hc.net;
    CA_KEYS.forEach(k=>{
      totCa[k].chess += hc.ca[k].chess;
      totCa[k].ace   += hc.ca[k].ace;
      totCa[k].total += hc.ca[k].total;
    });
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
<div class="kpi-row c7">
     ${kpiCard('전체 학기초 인원', tot.start, {unit:'명', ca:totCa.start})}
      ${kpiCard('전체 신규생', tot.newCnt, {unit:'명', ca:totCa.newCnt})}
      ${kpiCard('전체 전입', tot.transferIn, {unit:'명', ca:totCa.transferIn})}
      ${kpiCard('전체 퇴원생', tot.withdraw, {unit:'명', ca:totCa.withdraw})}
      ${kpiCard('전체 전출', tot.transfer, {unit:'명', ca:totCa.transfer})}
      ${kpiCard('전체 퇴원율', totWithdrawRate, {unit:'%'})}
      ${kpiCard('현 재원생', tot.active, {unit:'명', accent:true, ca:totCa.active})}
    </div>`+ transferWarnBox(semId) +`
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
        <div class="card-sub">신규 <b style="color:var(--brand)">${hc.newCnt}</b> · 퇴원 <b style="color:${wrColor}">${hc.withdraw}</b> <span style="color:${wrColor}">(${withdrawRate}%)</span> · 상담률 <b style="color:${hasData?rateColor(rates.totalRate):'var(--ink-3)'}">${hasData?rates.totalRate+'%':'–'}</b></div>
          <div class="card-ca"><span class="ca-chess">CHESS ${hc.ca.active.chess}</span><span class="ca-ace">ACE ${hc.ca.active.ace}</span></div>
        </div>
        <div class="card-headcount">
          <div class="hc-num num">${hc.active}</div>
          <div class="hc-label">현재 재원생</div>
        </div>
      </div>
      <div class="mini-stats">
        <div class="mini-stat"><div class="v num">${hc.start}</div><div class="l">학기초</div></div>
        <div class="mini-stat"><div class="v num" style="color:var(--brand)">${hc.newCnt}</div><div class="l">신규</div></div>
        <div class="mini-stat"><div class="v num" style="color:${hc.withdraw>0?'var(--neg)':'var(--ink-2)'}">${hc.withdraw}</div><div class="l">퇴원</div></div>
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
  const brate = calcRates(rateRecordsOf(branchId, semId), branchId, semId);
  const teachers = teachersOf(branchId, semId);

  let html = `
    ${backLink('통합 대시보드', 'admin')}
    <div class="page-head">
      <h2>${esc(b.name)}</h2>
      <div class="sub">분원 상세 현황 · ${esc(db.semesters.find(s=>s.id===semId).name)}</div>
    </div>
<div class="kpi-row c6">
      ${kpiCard('학기초 인원', hc.start, {unit:'명'})}
      ${kpiCard('신규생', hc.newCnt, {unit:'명'})}
      ${kpiCard('전입', hc.transferIn, {unit:'명'})}
      ${kpiCard('퇴원생', hc.withdraw, {unit:'명'})}
      ${kpiCard('전출', hc.transfer, {unit:'명'})}
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
/* 전출-전입 매칭 경고 박스 (통합 대시보드용).
   전출했는데 도착분원에 전입 안 잡힌 건 / 전입인데 출발분원에 전출 없는 건을 빨강으로 경고. */
function transferWarnBox(semId){
  const { matched, unmatchedOut, unmatchedIn } = transferMatch(semId);
  if(unmatchedOut.length===0 && unmatchedIn.length===0){
    if(matched.length===0) return '';  // 전출입 자체가 없으면 박스 안 띄움
    return `<div style="margin:14px 0;padding:12px 14px;border:1px solid var(--pos-soft);background:var(--pos-soft);border-radius:var(--radius-sm);font-size:12.5px;color:var(--pos)">
      ✓ 전출-전입 ${matched.length}건 모두 정상 매칭됨 (서수원 전출 = 장안 전입 식으로 양쪽 다 잡힘)</div>`;
  }
  const nameOf = bid => { const b=getBranch(bid); return b?b.name:'(분원?)'; };
  const stuOf = rec => { const s=getStudent(rec.studentId); return s?`${s.name}(${s.code})`:rec.studentId; };
  let rows = '';
  unmatchedOut.forEach(({out})=>{
    rows += `<div style="padding:4px 0">⚠ <b>${esc(nameOf(out.branchId))}</b>에서 <b>${esc(nameOf(out.transferTo))}</b>로 전출 처리한 <b>${esc(stuOf(out))}</b> — 도착 분원에 전입 기록이 없습니다.</div>`;
  });
  unmatchedIn.forEach(({in:i})=>{
    rows += `<div style="padding:4px 0">⚠ <b>${esc(nameOf(i.branchId))}</b>에 <b>${esc(nameOf(i.transferTo))}</b>에서 전입 처리한 <b>${esc(stuOf(i))}</b> — 출발 분원에 전출 기록이 없습니다.</div>`;
  });
  return `<div style="margin:14px 0;padding:14px 16px;border:1px solid var(--neg-soft);background:var(--neg-soft);border-radius:var(--radius-sm)">
    <div style="font-size:13px;font-weight:700;color:var(--neg);margin-bottom:6px">전출-전입 불일치 ${unmatchedOut.length+unmatchedIn.length}건 — 분원 간 확인 필요</div>
    <div style="font-size:12.5px;color:var(--ink-2);line-height:1.5">${rows}</div>
    ${matched.length?`<div style="margin-top:8px;font-size:12px;color:var(--pos)">✓ 정상 매칭 ${matched.length}건은 양쪽 다 잡혔습니다.</div>`:''}</div>`;
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
  const rates = calcRates(rateRecordsOf(branchId, semId), branchId, semId);
  const teachers = teachersOf(branchId, semId);

  let html = `
    <div class="page-head">
      <h2>${esc(b.name)} Dashboard</h2>
      <div class="sub">${esc(db.semesters.find(s=>s.id===semId).name)} 운영 현황</div>
    </div>
<div class="kpi-row c6">
      ${kpiCard('학기초 인원', hc.start, {unit:'명', ca:hc.ca.start})}
      ${kpiCard('신규생', hc.newCnt, {unit:'명', ca:hc.ca.newCnt})}
      ${kpiCard('전입', hc.transferIn, {unit:'명', ca:hc.ca.transferIn})}
      ${kpiCard('퇴원생', hc.withdraw, {unit:'명', ca:hc.ca.withdraw})}
      ${kpiCard('전출', hc.transfer, {unit:'명', ca:hc.ca.transfer})}
      ${kpiCard('현 재원생', hc.active, {unit:'명', accent:true, ca:hc.ca.active})}
    </div>
    <div class="sect-head"><h3>전체 상담률</h3>
    <span class="cnt">단계별 진행 현황</span></div>
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
  const rates = calcRates(rateRecordsOfTeacher(branchId, semId, teacher), branchId, semId);
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

  // 이 담임의 내신반 (인원 집계엔 안 들어가지만 상담표 진입용)
  const examTrecs = examRecordsOf(branchId, semId).filter(r=>r.teacher===teacher);
  if(examTrecs.length>0){
    const examClassMap = new Map();
    examTrecs.forEach(r=>{ if(!examClassMap.has(r.className)) examClassMap.set(r.className,[]); examClassMap.get(r.className).push(r); });
    const examCards = [...examClassMap.entries()].map(([className, crecs])=>{
      const rs = calcRates(crecs, branchId, semId);
      return `<div class="card clickable" onclick="go('branch/class/${encodeURIComponent(teacher)}/${encodeURIComponent(className)}')">
        <div class="card-top">
          <div><div class="card-name">${esc(className)}</div>
            <div class="card-sub">학생 ${crecs.length}명 <span style="color:var(--warn)">(인원 미집계)</span></div></div>
          <div class="card-rate"><div class="r num" style="color:${rateColor(rs.totalRate)}">${rs.totalTarget?rs.totalRate+'%':'–'}</div>
            <div class="rl">내신 MC</div></div>
        </div>
        <div class="card-foot"><span class="incomplete-tag">내신반</span>${goArrow}</div>
      </div>`;
    }).join('');
    html += `<div class="sect-head"><h3>내신반</h3><span class="cnt">내신기간 MC 진행 · 정규 인원에는 포함되지 않음</span></div>
      <div class="card-grid g4">${examCards}</div>`;
  }
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

  const recs = db.semesterRecords
    .filter(r=>r.branchId===branchId && r.semesterId===semId
      && r.teacher===teacher && r.className===className)
    .sort((a,b)=>{
      // 재원생 먼저, 그다음 퇴원생. 같은 상태면 이름순.
      const aw = a.status==='withdraw' ? 1 : 0;
      const bw = b.status==='withdraw' ? 1 : 0;
      if(aw!==bw) return aw-bw;
      return getStudent(a.studentId).name.localeCompare(getStudent(b.studentId).name,'ko');
    });
const isExamClass = recs.length>0 && (recs[0].kind||'regular')==='exam';
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
    const isExam = (rec.kind||'regular')==='exam';
const cells = STAGES.map(stg=>{
      const isMc = (stg==='MC1'||stg==='MC2'||stg==='MC3');
      const exempt = isMc && isExempt(rec.studentId, branchId, semId, stg);

      if(!isTarget(rec, stg, semId)){
        // 정규반에서 면제된 MC = 내신반으로 넘김. 분원관리자는 클릭해서 해제 가능.
        if(exempt && !isExam){
          const clk = canEditExempt() ? `onclick="onToggleExempt('${rec.studentId}','${stg}')"` : '';
          return `<td class="cc"><span class="cc-mark exempt ${canEditExempt()?'editable':''}" title="내신반으로 이관됨(면제). ${canEditExempt()?'클릭하면 해제':''}" ${clk}>–</span></td>`;
        }
        const why = (stg==='HC1'||stg==='HC2') ? '대상 아님(기존생)' : '대상 아님(입학 전 회차)';
        return `<td class="cc"><span class="cc-mark na" title="${why}">–</span></td>`;
      }
      const done = isDone(rec.studentId, branchId, semId, stg);
      if(done){
        return `<td class="cc"><span class="cc-mark done" title="상담 내용 보기"
          onclick="openCounseling('${rec.studentId}','${stg}','${esc(stu.name)}')">○</span></td>`;
      }
      const hasMistag = db.counselingHistories.some(c=>
        c.studentId===rec.studentId && c.branchId===branchId &&
        c.semesterId===semId && c.type===stg && c.mistag);
      if(hasMistag){
        return `<td class="cc"><span class="cc-mark mistag" title="대괄호 회차 오기재 의심 — 내용 확인"
          onclick="openCounseling('${rec.studentId}','${stg}','${esc(stu.name)}')">⚠</span></td>`;
      }
      // 미완료(✕). 정규반 MC면 분원관리자가 클릭해서 면제(–)로 바꿀 수 있음.
      if(isMc && !isExam && canEditExempt()){
        return `<td class="cc"><span class="cc-mark undone editable" title="미완료 — 클릭하면 내신반으로 이관(면제)"
          onclick="onToggleExempt('${rec.studentId}','${stg}')">✕</span></td>`;
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
      <h2>${esc(classLbl)} <span style="font-size:14px;font-weight:500;color:${isExamClass?'var(--warn)':'var(--ink-3)'}">${isExamClass?'내신반 상담표':'상담표'}</span></h2>
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
/* 면제 토글 권한 — 분원관리자만 */
function canEditExempt(){ return session && session.role==='branch'; }
/* 셀에서 면제 토글 클릭 */
function onToggleExempt(studentId, stage){
  if(!canEditExempt()){ toast('분원 관리자만 변경할 수 있습니다','err'); return; }
  const branchId = activeBranchId();
  toggleExemption(studentId, branchId, state.semId, stage);
  render();
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
   14-2. 신규·퇴원 명단 (관리자=요약+분원카드, 클릭→분원상세 / 분원=바로 상세)
   ============================================================================ */
/* 한 분원의 신규·퇴원 인원 집계 */
function rosterCount(branchId, semId){
  let newCnt=0, transferInCnt=0, wdCnt=0, transferOutCnt=0;
  recordsOf(branchId, semId).forEach(r=>{
    if((r.origin==='new' || r.origin==='return') && !r.transferIn) newCnt++;
    if(r.transferIn) transferInCnt++;
    if(r.status==='withdraw' && !r.transfer) wdCnt++;
    if(r.status==='withdraw' && r.transfer) transferOutCnt++;
  });
  return { newCnt, transferInCnt, wdCnt, transferOutCnt };
}
/* 한 분원의 신규 또는 퇴원 학생 행 목록 */
function rosterRows(branchId, semId, tab){
  const rows = [];
  recordsOf(branchId, semId).forEach(r=>{
    const s = getStudent(r.studentId);
    if(!s) return;
    // 4분류: new(순수신규)/transferIn(전입)/withdraw(순수퇴원)/transferOut(전출)
   if(tab==='new' && !((r.origin==='new' || r.origin==='return') && !r.transferIn)) return;
    if(tab==='transferIn' && !r.transferIn) return;
    if(tab==='withdraw' && !(r.status==='withdraw' && !r.transfer)) return;
    if(tab==='transferOut' && !(r.status==='withdraw' && r.transfer)) return;
    const isIn = (tab==='new' || tab==='transferIn');
    const mvType = isIn ? 'new' : 'withdraw';
    const mv = db.studentMovements.find(m=>m.studentId===r.studentId && m.branchId===branchId && m.semesterId===semId && m.type===mvType);
    const date = isIn ? (r.enrollDate || (mv&&mv.date) || '-')
                      : (r.withdrawDate || (mv&&mv.date) || '-');
rows.push({
      name:s.name, code:s.code, school:s.school||'', grade:s.grade||'',
      classLabel:r.classLabel||r.className||'-', className:r.className||'', teacher:r.teacher||'-',
date, memo:(mv&&mv.memo)||'',
      recId:r.id, withdrawReason:r.withdrawReason||'', withdrawMemo:r.withdrawMemo||'',
    });
  });
  rows.sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  return rows;
}

function renderRoster(){
  const isAdmin = session.role==='admin';
  const semId = state.semId;
  // 분원 계정은 곧장 자기 분원 상세로
  if(!isAdmin){ renderRosterDetail(session.branchId); return; }

  crumbs([{label:'신규·퇴원 명단'}]);

// 전체 요약 + 분원별 카드
  let totNew=0, totIn=0, totWd=0, totOut=0;
  const cards = db.branches.map(b=>{
    const c = rosterCount(b.id, semId);
    totNew+=c.newCnt; totIn+=c.transferInCnt; totWd+=c.wdCnt; totOut+=c.transferOutCnt;
    return { b, ...c };
  });

  let html = `
    <div class="page-head">
      <h2>신규·전입·퇴원·전출 명단</h2>
      <div class="sub">전 분원 · ${esc(db.semesters.find(s=>s.id===semId).name)}</div>
    </div>
    <div class="kpi-row c4">
      ${kpiCard('전체 신규생', totNew, {unit:'명', accent:true})}
      ${kpiCard('전체 전입', totIn, {unit:'명'})}
      ${kpiCard('전체 퇴원생', totWd, {unit:'명'})}
      ${kpiCard('전체 전출', totOut, {unit:'명'})}
    </div>
    <div class="sect-head"><h3>분원별 현황</h3><span class="cnt">카드를 클릭하면 명단 상세로 이동</span></div>
    <div class="card-grid g3">
    ${cards.map(({b,newCnt,transferInCnt,wdCnt,transferOutCnt})=>{
      const total = newCnt+transferInCnt+wdCnt+transferOutCnt;
      return `<div class="card clickable" onclick="go('roster/branch/${b.id}')">
        <div class="card-top">
          <div><div class="card-name">${esc(b.name)}</div>
            <div class="card-sub">${total>0?'클릭해서 명단 보기':'변동 없음'}</div></div>
        </div>
        <div class="roster-mini" style="grid-template-columns:repeat(4,1fr)">
          <div class="rm-box new"><div class="rm-num">${newCnt}</div><div class="rm-label">신규</div></div>
          <div class="rm-box" style="background:var(--pos-soft)"><div class="rm-num" style="color:var(--pos)">${transferInCnt}</div><div class="rm-label">전입</div></div>
          <div class="rm-box wd"><div class="rm-num">${wdCnt}</div><div class="rm-label">퇴원</div></div>
          <div class="rm-box" style="background:var(--warn-soft)"><div class="rm-num" style="color:var(--warn)">${transferOutCnt}</div><div class="rm-label">전출</div></div>
        </div>
        <div class="card-foot"><span></span>${goArrow}</div>
      </div>`;
    }).join('')}
    </div>`;
  el('content').innerHTML = html;
}

/* 분원별 신규·퇴원 명단 상세 (신규/퇴원 탭 + 표) */
function renderRosterDetail(branchId){
  const isAdmin = session.role==='admin';
  const b = getBranch(branchId);
  if(!b){ go('roster'); return; }
  const semId = state.semId;
  const tab = state.rosterTab || 'new';

  if(isAdmin){
    crumbs([{label:'신규·퇴원 명단', go:'roster'},{label:b.name}]);
  } else {
    crumbs([{label:'신규·퇴원 명단'}]);
  }

 const c = rosterCount(branchId, semId);
const isInTab = (tab==='new' || tab==='transferIn' || tab==='transferOut');
  let rows = rosterRows(branchId, semId, tab);

  // 담임 목록 (필터 드롭다운용)
  const teacherSet = [...new Set(rows.map(r=>r.teacher).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));

  // 필터 적용 — 담임은 리렌더로, 검색은 DOM에서(아래 표에 data속성)
  const fTeacher = state.rosterTeacher||'';
  const fQuery = (state.rosterQuery||'').trim().toLowerCase();
  if(fTeacher) rows = rows.filter(r=>r.teacher===fTeacher);

  let html = `
    ${isAdmin?backLink('신규·퇴원 명단','roster'):''}
    <div class="page-head">
      <h2>${esc(b.name)} 신규·퇴원 명단</h2>
      <div class="sub">${esc(db.semesters.find(s=>s.id===semId).name)}</div>
    </div>
  <div class="sort-bar" style="margin-bottom:12px">
      <button class="sb-btn ${tab==='new'?'on':''}" onclick="setRosterTab('new')">신규생 ${c.newCnt}</button>
      <button class="sb-btn ${tab==='transferIn'?'on':''}" onclick="setRosterTab('transferIn')">전입 ${c.transferInCnt}</button>
      <button class="sb-btn ${tab==='withdraw'?'on':''}" onclick="setRosterTab('withdraw')">퇴원생 ${c.wdCnt}</button>
      <button class="sb-btn ${tab==='transferOut'?'on':''}" onclick="setRosterTab('transferOut')">전출 ${c.transferOutCnt}</button>
    </div>
<div style="margin:0 0 12px;display:flex;gap:8px;align-items:center">
      <span style="font-size:12.5px;font-weight:600;background:#E6F1FB;color:#0C447C;border-radius:6px;padding:3px 10px">CHESS ${countChessAce(rows).chess}</span>
      <span style="font-size:12.5px;font-weight:600;background:#E1F5EE;color:#085041;border-radius:6px;padding:3px 10px">ACE ${countChessAce(rows).ace}</span>
      <span style="font-size:12.5px;color:var(--ink-3)">· 합 ${rows.length}</span>
    </div>
    <div class="roster-filter">
      <select onchange="setRosterTeacher(this.value)">
        <option value="">담임 전체</option>
        ${teacherSet.map(t=>`<option value="${esc(t)}" ${fTeacher===t?'selected':''}>${esc(t)}</option>`).join('')}
      </select>
      <input placeholder="이름·회원코드 검색" value="${esc(state.rosterQuery||'')}" oninput="setRosterQuery(this.value)">
      ${(fTeacher||fQuery)?`<button class="rf-clear" onclick="clearRosterFilter()">필터 해제</button>`:''}
    </div>`;

  if(rows.length===0){
    const emptyMsg = {new:'신규생이 없습니다', transferIn:'전입생이 없습니다', withdraw:'퇴원생이 없습니다', transferOut:'전출생이 없습니다'}[tab] || '없습니다';
    html += emptyState(emptyMsg, '');
  } else {
    html += `<div class="table-wrap"><div class="table-scroll">
      <table class="rank-table" id="rosterTable">
        <thead><tr>
          <th>학생명</th><th>회원코드</th><th>반</th><th>담임</th>
          <th>학교/학년</th><th>${(tab==='new'||tab==='transferIn')?'입학일':'퇴원일'}</th>
          ${isInTab?'<th>메모</th>':'<th style="width:130px">사유</th><th style="min-width:200px">메모</th>'}
        </tr></thead>
        <tbody>
        ${rows.map(r=>{
          const memoShown = (r.memo && r.memo!=='수동 등록' && r.memo!=='퇴원 처리') ? r.memo : '';
          const tail = isInTab
            ? `<td style="color:var(--ink-3);font-size:12px">${esc(memoShown)}</td>`
            : `<td>
                 <select class="wd-inline-sel" onchange="setWdReason('${r.recId}', this.value)">
                   <option value="">미분류</option>
                   ${WITHDRAW_REASONS.map(w=>`<option value="${w.code}" ${r.withdrawReason===w.code?'selected':''}>${esc(w.label)}</option>`).join('')}
                 </select>
               </td>
               <td>
                 <input class="wd-inline-memo" value="${esc(r.withdrawMemo)}" placeholder="메모"
                   onblur="setWdMemo('${r.recId}', this.value)"
                   onkeydown="if(event.key==='Enter')this.blur()">
               </td>`;
          return `<tr data-name="${esc(r.name)}" data-code="${esc(r.code)}">
          <td class="nm">${esc(r.name)}</td>
          <td><span class="code-chip">${esc(r.code)}</span></td>
         <td>${esc(r.classLabel)}</td>
          <td>${esc(r.teacher)}</td>
          <td style="color:var(--ink-3);font-size:12px">${esc(r.school)} ${esc(r.grade)}${r.grade?'학년':''}</td>
          <td class="num">${esc(r.date)}</td>
          ${tail}
        </tr>`;}).join('')}
        </tbody>
      </table>
    </div></div>
<div style="margin-top:10px;font-size:12px;color:var(--ink-3)">총 ${rows.length}명${fTeacher?` · ${esc(fTeacher)} 담임`:''} · 최근 순</div>`;
  }
  el('content').innerHTML = html;
  if(state.rosterQuery) setRosterQuery(state.rosterQuery);
}
/* 명단 표에서 퇴원 사유/메모 인라인 수정 — 리렌더 없이 즉시 저장 */
function setWdReason(recId, code){
  const rec = db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  rec.withdrawReason = code || null;
  saveDB().then(ok=>{ if(!ok) toast('저장 실패','err'); });
}
function setWdMemo(recId, val){
  const rec = db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const v = (val||'').trim();
  if((rec.withdrawMemo||'') === v) return;   // 변경 없으면 저장 스킵
  rec.withdrawMemo = v;
  saveDB().then(ok=>{ if(!ok) toast('저장 실패','err'); });
}
function setRosterTab(tab){ state.rosterTab=tab; state.rosterTeacher=''; state.rosterQuery=''; render(); }
function setRosterTeacher(v){ state.rosterTeacher=v; render(); }
function clearRosterFilter(){ state.rosterTeacher=''; state.rosterQuery=''; render(); }
/* 검색은 전체 리렌더 없이 표 행만 즉시 필터(입력 포커스 유지) */
function setRosterQuery(v){
  state.rosterQuery=v;
  const q=(v||'').trim().toLowerCase();
  document.querySelectorAll('#rosterTable tbody tr').forEach(tr=>{
    const name=(tr.dataset.name||'').toLowerCase();
    const code=(tr.dataset.code||'').toLowerCase();
    tr.style.display = (!q || name.includes(q) || code.includes(q)) ? '' : 'none';
  });
}

/* ============================================================================
   14-3. 인원마감표 (강사별·레벨별 월별 퇴원현황)
   ============================================================================ */
/* 관리자: 분원 고르는 허브 */
function renderClosingHub(){
  const semId = state.semId;
  crumbs([{label:'인원마감표'}]);
  let html = `
    <div class="page-head">
      <h2>인원마감표</h2>
      <div class="sub">분원을 선택하면 강사별·레벨별 월별 퇴원현황을 봅니다 · ${esc(db.semesters.find(s=>s.id===semId).name)}</div>
    </div>
    <div class="card-grid g3">
    ${db.branches.map(b=>{
      const recs = recordsOf(b.id, semId);
      const active = recs.filter(r=>r.status!=='withdraw').length;
      const wd = recs.filter(r=>r.status==='withdraw').length;
      return `<div class="card clickable" onclick="go('closing/branch/${b.id}')">
        <div class="card-top">
          <div><div class="card-name">${esc(b.name)}</div>
            <div class="card-sub">재원 ${active} · 퇴원 ${wd}</div></div>
          ${goArrow}
        </div>
      </div>`;
    }).join('')}
    </div>`;
  el('content').innerHTML = html;
}

function closingTable(groups, months, firstColLabel, totalRecs, opts={}){
  const showCA = opts.showCA === true;          // 각 행마다 CHESS/ACE (강사별)
  const showCAFoot = opts.showCAFoot !== false; // 맨 밑 합계 CHESS/ACE (기본 켜짐)  // 기본 true (강사별). 끄려면 {showCA:false}
  const caCol = showCA || showCAFoot;   // 구분 열을 만들지 여부
  const monthNames = months.map(m=>m+'월');
  const COLSPAN_MONTH = 6;
 
  // 한 그룹의 특정 레코드셋으로 월별 셀 HTML 생성 (split 없이 단순 — CHESS/ACE 행용)
  function cellsHtmlSimple(recs, extraCls){
    const r = monthlyClosing(recs, months);
    return r.cells.map(c=>{
      const trCell = c.transfer ? `<span style="color:var(--warn)">${c.transfer}</span>` : '-';
      const tiCell = c.transferIn ? `<span style="color:var(--pos)">${c.transferIn}</span>` : '-';
      return `<td class="num cc${extraCls}">${c.monthStart||'-'}</td>
        <td class="num cc${extraCls}">${c.newThis||'-'}</td>
        <td class="num cc${extraCls}">${tiCell}</td>
        <td class="num cc${extraCls}">${c.withdraw||'-'}</td>
        <td class="num cc${extraCls}">${trCell}</td>
        <td class="num cc${extraCls}"><span style="color:var(--ink-3)">${c.baseNew?c.rate.toFixed(1)+'%':'-'}</span></td>`;
    }).join('');
  }
 
  const bodyRows = groups.map((g, i)=>{
    // 합계행: 기존 로직 그대로 (split 정확 반영)
    const r = monthlyClosing(g.recs, months, g.activeMonths, g.splits);
    const splitMonths = new Set((g.splits||[]).map(s=>s.month));
    const monthCells = r.cells.map(c=>{
      if(c.blank) return `<td class="num cc cell-na">-</td>`.repeat(6);
      const cls = splitMonths.has(c.month) ? ' cell-split' : '';
      const trCell = c.transfer ? `<span style="color:var(--warn)">${c.transfer}</span>` : '-';
      const tiCell = c.transferIn ? `<span style="color:var(--pos)">${c.transferIn}</span>` : '-';
      return `<td class="num cc${cls}">${c.monthStart||'-'}</td>
        <td class="num cc${cls}">${c.newThis||'-'}</td>
        <td class="num cc${cls}">${tiCell}</td>
        <td class="num cc${cls}">${c.withdraw||'-'}</td>
        <td class="num cc${cls}">${trCell}</td>
        <td class="num cc${cls}"><span style="color:${c.rate>=10?'var(--neg)':c.rate>=5?'var(--warn)':'var(--ink-2)'}">${c.baseNew?c.rate.toFixed(1)+'%':'-'}</span></td>`;
    }).join('');
 
    const rowspan = showCA ? 3 : 1;
    const totalRow = `<tr class="clos-main">
      <td class="cc" rowspan="${rowspan}">${i+1}</td>
      <td class="cc" rowspan="${rowspan}"><span class="nm">${esc(g.name)}</span></td>
     ${showCA?`<td class="cc clos-catag clos-sum">합계</td>`:(caCol?`<td class="cc"></td>`:'')}
     ${monthCells}
      <td class="num cc" style="font-weight:700">${r.totNew||'-'}</td>
      <td class="num cc" style="font-weight:700;color:${r.totTransferIn?'var(--pos)':'inherit'}">${r.totTransferIn||'-'}</td>
      <td class="num cc" style="font-weight:700">${r.totWithdraw||'-'}</td>
      <td class="num cc" style="font-weight:700;color:${r.totTransfer?'var(--warn)':'inherit'}">${r.totTransfer||'-'}</td>
      <td class="num cc"><span style="font-weight:700;color:${r.avgRate>=10?'var(--neg)':r.avgRate>=5?'var(--warn)':'var(--brand)'}">${r.avgRate?r.avgRate.toFixed(1)+'%':'-'}</span></td>
    </tr>`;
 
    if(!showCA) return totalRow;
 
    // CHESS / ACE 행 (단순 집계)
    const chessRecs = g.recs.filter(r=>isChess(r.className));
    const aceRecs   = g.recs.filter(r=>!isChess(r.className));
    const cR = monthlyClosing(chessRecs, months);
    const aR = monthlyClosing(aceRecs, months);
    const caRow = (label, tagCls, recs, mc)=>`<tr class="clos-ca">
      <td class="cc clos-catag ${tagCls}">${label}</td>
     ${cellsHtmlSimple(recs, ' clos-ca-cell')}
      <td class="num cc clos-ca-cell">${mc.totNew||'-'}</td>
      <td class="num cc clos-ca-cell">${mc.totTransferIn||'-'}</td>
      <td class="num cc clos-ca-cell">${mc.totWithdraw||'-'}</td>
      <td class="num cc clos-ca-cell">${mc.totTransfer||'-'}</td>
      <td class="num cc clos-ca-cell">${mc.avgRate?mc.avgRate.toFixed(1)+'%':'-'}</td>
    </tr>`;
 
    return totalRow
      + caRow('CHESS','clos-chess', chessRecs, cR)
      + caRow('ACE','clos-ace', aceRecs, aR);
  }).join('');
 
  // 합계(맨 아래)
  const baseForTotal = totalRecs || groups.reduce((acc,g)=>acc.concat(g.recs),[]);
  const totR = monthlyClosing(baseForTotal, months);
  const totalCells = totR.cells.map(c=>{
    const trCell = c.transfer ? `<span style="color:var(--warn)">${c.transfer}</span>` : '-';
    const tiCell = c.transferIn ? `<span style="color:var(--pos)">${c.transferIn}</span>` : '-';
    return `<td class="num cc">${c.monthStart||'-'}</td><td class="num cc">${c.newThis||'-'}</td>
      <td class="num cc">${tiCell}</td>
      <td class="num cc">${c.withdraw||'-'}</td><td class="num cc">${trCell}</td>
      <td class="num cc">${c.baseNew?c.rate.toFixed(1)+'%':'-'}</td>`;
  }).join('');

  // 합계 CHESS/ACE
  const chessTotRecs = baseForTotal.filter(r=>isChess(r.className));
  const aceTotRecs   = baseForTotal.filter(r=>!isChess(r.className));
  function footCellsSimple(recs){
    const rr = monthlyClosing(recs, months);
    return rr.cells.map(c=>{
      const trCell = c.transfer ? `<span style="color:var(--warn)">${c.transfer}</span>` : '-';
      const tiCell = c.transferIn ? `<span style="color:var(--pos)">${c.transferIn}</span>` : '-';
      return `<td class="num cc">${c.monthStart||'-'}</td><td class="num cc">${c.newThis||'-'}</td>
        <td class="num cc">${tiCell}</td><td class="num cc">${c.withdraw||'-'}</td><td class="num cc">${trCell}</td>
        <td class="num cc">${c.baseNew?c.rate.toFixed(1)+'%':'-'}</td>`;
    }).join('');
  }
  const cTot = monthlyClosing(chessTotRecs, months);
  const aTot = monthlyClosing(aceTotRecs, months);
 
  const monthHeads = monthNames.map(mn=>`<th class="cc" colspan="6">${mn}</th>`).join('');
  const subHeads = months.map(()=>`<th class="cc">월초</th><th class="cc">신규</th><th class="cc">전입</th><th class="cc">퇴원</th><th class="cc">전출</th><th class="cc">퇴원율</th>`).join('');
  const caHead = caCol ? `<th class="cc" rowspan="2">구분</th>` : '';
  const caFootCell = showCA ? `<td class="cc"></td>` : '';
 
 return `<div class="table-wrap closing-wrap"><div class="table-scroll">
    <table class="rank-table closing-table${showCA?' closing-ca':''}">
      <thead>
        <tr><th class="cc" rowspan="2">#</th><th class="cc" rowspan="2">${firstColLabel}</th>${caHead}${monthHeads}
          <th class="cc" colspan="5">학기 계</th></tr>
        <tr>${subHeads}<th class="cc">총신규</th><th class="cc">총전입</th><th class="cc">총퇴원</th><th class="cc">총전출</th><th class="cc">평균퇴원율</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
<tr class="closing-total">
          <td class="cc" ${caCol?'rowspan="3"':''}></td>
          <td class="cc nm" ${caCol?'rowspan="3"':''}>합계</td>
          ${caCol?`<td class="cc clos-catag clos-sum">합계</td>`:''}
          ${totalCells}
          <td class="num cc" style="font-weight:800">${totR.totNew}</td>
          <td class="num cc" style="font-weight:800;color:${totR.totTransferIn?'var(--pos)':'inherit'}">${totR.totTransferIn}</td>
          <td class="num cc" style="font-weight:800">${totR.totWithdraw}</td>
          <td class="num cc" style="font-weight:800;color:${totR.totTransfer?'var(--warn)':'inherit'}">${totR.totTransfer}</td>
          <td class="num cc" style="font-weight:800">${totR.avgRate.toFixed(1)}%</td>
        </tr>
        ${showCAFoot?`
        <tr class="closing-total clos-ca">
          <td class="cc clos-catag clos-chess">CHESS</td>
          ${footCellsSimple(chessTotRecs)}
          <td class="num cc">${cTot.totNew||'-'}</td>
          <td class="num cc">${cTot.totTransferIn||'-'}</td>
          <td class="num cc">${cTot.totWithdraw||'-'}</td>
          <td class="num cc">${cTot.totTransfer||'-'}</td>
          <td class="num cc">${cTot.avgRate?cTot.avgRate.toFixed(1)+'%':'-'}</td>
        </tr>
        <tr class="closing-total clos-ca">
          <td class="cc clos-catag clos-ace">ACE</td>
          ${footCellsSimple(aceTotRecs)}
          <td class="num cc">${aTot.totNew||'-'}</td>
          <td class="num cc">${aTot.totTransferIn||'-'}</td>
          <td class="num cc">${aTot.totWithdraw||'-'}</td>
          <td class="num cc">${aTot.totTransfer||'-'}</td>
          <td class="num cc">${aTot.avgRate?aTot.avgRate.toFixed(1)+'%':'-'}</td>
        </tr>
        `:''}
      </tfoot>
    </table>
  </div></div>`;
}

function renderClosing(branchId){
  const isAdmin = session.role==='admin';
  const b = getBranch(branchId);
  if(!b){ go(isAdmin?'closing':'branch'); return; }
  const semId = state.semId;
  const months = semesterMonths(semId);
  const tab = state.closingTab || 'teacher';

  if(isAdmin) crumbs([{label:'인원마감표', go:'closing'},{label:b.name}]);
  else crumbs([{label:'인원마감표'}]);

  const recs = recordsOf(branchId, semId);
  const tabBtn = (key,label)=>`<button class="sb-btn ${tab===key?'on':''}" onclick="setClosingTab('${key}')">${label}</button>`;
  const tabBar = `<div class="sort-bar" style="margin-bottom:16px">
      ${tabBtn('teacher','강사별')}${tabBtn('level','레벨별')}${tabBtn('grade','학년별')}${tabBtn('daily','일별')}
    </div>`;
  const headHtml = `
    ${isAdmin?backLink('인원마감표','closing'):''}
    <div class="page-head">
      <h2>${esc(b.name)} 인원마감표</h2>
      <div class="sub">${esc(db.semesters.find(s=>s.id===semId).name)} · 월별 퇴원현황 (월초+신규 / 퇴원 / 퇴원율)</div>
    </div>${tabBar}`;

  // 일별 탭은 별도 렌더
  if(tab==='daily'){ renderClosingDaily(branchId, headHtml); return; }

  // 탭별 그룹 구성
  let groups, firstCol, note='';
  if(tab==='teacher'){
    groups = teacherGroupsWithChanges(branchId, semId, recs, months);
    firstCol = '강사명';
  } else if(tab==='level'){
    const m = new Map();
    recs.forEach(r=>{ const lv=classLevel(r.className||'')||'기타'; if(!m.has(lv)) m.set(lv,[]); m.get(lv).push(r); });
    groups = [...m.entries()].map(([name,recs])=>({name,recs})).sort((a,b)=> a.name.localeCompare(b.name));
    firstCol = '레벨';
  } else { // grade
    const m = new Map();
    recs.forEach(r=>{ const s=getStudent(r.studentId); const gk=gradeKey(s)||'미상'; if(!m.has(gk)) m.set(gk,[]); m.get(gk).push(r); });
    groups = [...m.entries()].map(([name,recs])=>({name,recs}))
      .sort((a,b)=> gradeOrder(a.name)-gradeOrder(b.name));
    firstCol = '학년';
  }

  let html = headHtml + `
    ${closingTable(groups, months, firstCol, recs, {showCA: tab==='teacher'})}
    ${note?`<div class="closing-note">${esc(note)}</div>`:''}
    <div style="margin-top:12px;font-size:12px;color:var(--ink-3)">
      월초+신규 = 그 달 시작 인원 + 그 달 신규 · 퇴원율 = 퇴원 ÷ (월초+신규) · 평균퇴원율 = 월별 퇴원율의 평균 · 전출은 퇴원에서 제외됩니다.
    </div>`;
  el('content').innerHTML = html;
  el('content').style.maxWidth = '1450px';
}

/* 담임 변경을 반영한 강사별 그룹 생성 (날짜 정확히 쪼개기).
   변경 없는 반: 현재 담임에 통째로 (모든 월 담당).
   변경된 반: 변경월은 둘 다 담당하되 그 달을 변경일 기준으로 날짜 쪼갬.
   - 변경 전 담임: 변경월 이전 달들 + 변경월의 (1일~변경일 전날) 구간
   - 변경 후 담임: 변경월의 (변경일~말일) 구간 + 변경월 이후 달들 */
function teacherGroupsWithChanges(branchId, semId, recs, months){
  const changes = (db.teacherChanges||[]).filter(c=>c.branchId===branchId && c.semesterId===semId);
  const changeByClass = new Map();
  changes.forEach(c=>{ changeByClass.set(c.className, c); });

  const groupMap = new Map();
  const ensure = (t)=>{ if(!groupMap.has(t)) groupMap.set(t, { name:t, recs:[], months:new Set(), splits:[] }); return groupMap.get(t); };

  const byClass = new Map();
  recs.forEach(r=>{ const k=r.className||'(미배정)'; if(!byClass.has(k)) byClass.set(k,[]); byClass.get(k).push(r); });

  byClass.forEach((classRecs, className)=>{
    const ch = changeByClass.get(className);
    if(!ch){
      const t = classRecs[0].teacher || '미배정';
      const g = ensure(t);
      classRecs.forEach(r=> g.recs.push(r));
      months.forEach(m=> g.months.add(m));
      return;
    }
    const chMonth = monthOfDate(ch.date);
    const chDay = dayOfDate(ch.date) || 1;
    const beforeMonths = months.filter(m=> m < chMonth);
    const afterMonths  = months.filter(m=> m > chMonth);
    const hasChMonth = months.includes(chMonth);

    // 변경 전 담임: 이전 달들 (통째) + 변경월 앞부분(날짜 쪼갬)
    const gBefore = ensure(ch.fromTeacher||'미배정');
    classRecs.forEach(r=> gBefore.recs.push(r));
    beforeMonths.forEach(m=> gBefore.months.add(m));
    if(hasChMonth && chDay>1){
      gBefore.months.add(chMonth);
      gBefore.splits.push({ className, month:chMonth, cutDay:chDay, side:'before' });
    }

    // 변경 후 담임: 변경월 뒷부분(날짜 쪼갬) + 이후 달들(통째)
    const gAfter = ensure(ch.toTeacher||'미배정');
    classRecs.forEach(r=> gAfter.recs.push(r));
    afterMonths.forEach(m=> gAfter.months.add(m));
    if(hasChMonth){
      gAfter.months.add(chMonth);
      gAfter.splits.push({ className, month:chMonth, cutDay:chDay, side:'after' });
    }
  });

  const allMonthsCount = months.length;
  return [...groupMap.values()].map(g=>{
    return { name:g.name, recs:g.recs, activeMonths:g.months, splits:g.splits };
  }).sort((a,b)=> b.recs.length - a.recs.length);
}

/* 일별 퇴원율 집계 — 월 선택 + 날짜별 표 */
function renderClosingDaily(branchId, headHtml){
  const semId = state.semId;
  const months = semesterMonths(semId);
  const month = state.closingMonth || months[0];
  const m = String(semId).match(/sem_(\d+)_/);
  let year = m ? parseInt(m[1],10) : new Date().getFullYear();
  // 겨울학기 1,2월은 다음 해
  if(month<=2 && months.includes(12)) year = year; // sem id의 연도가 이미 보정돼 있음
  const recs = recordsOf(branchId, semId);
  const data = dailyClosing(recs, year, month);

  const monthBtns = months.map(mo=>`<button class="sb-btn ${month===mo?'on':''}" onclick="setClosingMonth(${mo})">${mo}월</button>`).join('');

 const rows = data.rows.map(r=>{
    const wk = ['일','월','화','수','목','금','토'][new Date(year, month-1, r.d).getDay()];
    const wdCell = r.wdToday
      ? `<span style="color:var(--neg)">${r.wdToday}</span>${r.trToday?`<span style="color:var(--warn);font-size:11px"> +${r.trToday}전출</span>`:''}`
      : (r.trToday?`<span style="color:var(--warn);font-size:11px">${r.trToday}전출</span>`:'-');
return `<tr>
      <td class="cc">${month}/${r.d}</td>
      <td class="cc" style="color:var(--ink-3)">${wk}</td>
      <td class="num cc">${r.newToday||'-'}</td>
      <td class="num cc">${r.newAcc||'-'}</td>
      <td class="num cc" style="font-weight:700">${r.base}</td>
      <td class="num cc">${r.wdToday?`<span style="color:var(--neg)">${r.wdToday}</span>`:'-'}</td>
      <td class="num cc">${r.trToday?`<span style="color:var(--warn)">${r.trToday}</span>`:'-'}</td>
      <td class="num cc">${r.wdAcc||'-'}</td>
      <td class="num cc">${r.wdToday?`<span style="color:${r.rate>=2?'var(--neg)':'var(--ink-2)'}">${r.rate.toFixed(2)}%</span>`:'-'}</td>
    </tr>`;
  }).join('');

  const monthWd = data.rows.reduce((a,c)=>a+c.wdToday,0);
  const monthTr = data.rows.reduce((a,c)=>a+(c.trToday||0),0);
  const monthNew = data.rows.reduce((a,c)=>a+c.newToday,0);
  const monthRate = data.startCount>0 ? (monthWd/(data.startCount+monthNew)*100) : 0;
// 이달 전입 + CHESS/ACE 집계
  const monthTiRecs = recs.filter(r=> r.transferIn && enrollMonth(r)===month );
  const monthTi = monthTiRecs.length;
  const monthNewRecs = recs.filter(r=> (r.origin==='new'||r.origin==='return') && !r.transferIn && enrollMonth(r)===month );
  const monthWdRecs  = recs.filter(r=> withdrawMonth(r)===month && !r.transfer );
  const monthTrRecs  = recs.filter(r=> withdrawMonth(r)===month && r.transfer );
  const startRecs    = recs.filter(r=> (enrollMonth(r)==null || enrollMonth(r)<month) && (withdrawMonth(r)==null || withdrawMonth(r)>=month) );
  const endRecs      = recs.filter(r=> (enrollMonth(r)==null || enrollMonth(r)<=month) && (withdrawMonth(r)==null || withdrawMonth(r)>month) );
  let html = headHtml + `
    <div class="sort-bar" style="margin-bottom:14px">${monthBtns}</div>
<div class="kpi-row c6">
      ${kpiCard('월초 인원', data.startCount, {unit:'명', ca:countChessAce(startRecs)})}
      ${kpiCard('이달 신입(누계)', monthNew, {unit:'명', accent:true, ca:countChessAce(monthNewRecs)})}
      ${kpiCard('이달 전입(누계)', monthTi, {unit:'명', ca:countChessAce(monthTiRecs)})}
      ${kpiCard('이달 퇴원(누계)', monthWd, {unit:'명', ca:countChessAce(monthWdRecs)})}
      ${kpiCard('이달 전출(누계)', monthTr, {unit:'명', ca:countChessAce(monthTrRecs)})}
      ${kpiCard('말일 현원', data.endCount, {unit:'명', ca:countChessAce(endRecs)})}
    </div>
  <div class="table-wrap closing-wrap"><div class="table-scroll">
      <table class="rank-table closing-table">
        <thead><tr>
          <th class="cc">날짜</th><th class="cc">요일</th>
          <th class="cc">신입</th><th class="cc">신입누계</th><th class="cc">기준학생수</th>
          <th class="cc">퇴원</th><th class="cc">전출</th><th class="cc">퇴원누계</th><th class="cc">퇴원율</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div></div>
    <div style="margin-top:12px;font-size:12px;color:var(--ink-3)">
      기준학생수 = 그날 신입까지 더한 인원 · 퇴원율 = 그날 퇴원 ÷ 기준학생수 · 전출은 퇴원에서 제외됩니다.
    </div>`;
  el('content').innerHTML = html;
}
function setClosingTab(tab){ state.closingTab=tab; render(); }
function setClosingMonth(mo){ state.closingMonth=mo; render(); }

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
        <div class="pd">학생 DB이자 학기별 반·담임 정보의 기준입니다. 정상 IMS에서 내려받은 전체명단 엑셀을 그대로 올리면 됩니다. 특이사항 열에 '신규생' 또는 '복학생'이 적힌 학생만 HC1·HC2 대상이 됩니다. 같은 학생을 다시 올리면 최신 반·담임 정보로 갱신됩니다.</div>
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
      <div class="pd">필요한 것만 골라서 비울 수 있습니다. 전체명단과 상담이력은 따로 지워집니다. 아래 '상담이력 업로드 내역'에서 잘못 올린 묶음만 골라 지울 수도 있습니다.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
        <button class="btn" style="border-color:var(--neg-soft);color:var(--neg)" onclick="confirmClearHistory()">상담이력 전체 삭제</button>
        <button class="btn" style="border-color:var(--neg-soft);color:var(--neg)" onclick="confirmClearRoster()">전체명단 삭제</button>
      </div>
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line-2)">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">학생 개별 삭제</div>
        <div class="pd" style="margin-bottom:8px">특정 학생만 명단에서 제거합니다. 이름이나 회원코드로 검색해서 고르세요. (해당 학생의 상담이력도 함께 삭제됩니다)</div>
        <input id="delSearch" placeholder="예: 김태양" autocomplete="off" oninput="renderDelResults()" style="width:100%;height:38px;padding:0 11px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2)">
        <div id="delResults" class="wd-results" style="margin-top:8px"></div>
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
  if(isPastSemester(state.semId)){ lockedPastToast(); return; }
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

/* 학생 개별 삭제 — 검색 결과 렌더 */
function renderDelResults(){
  const branchId=session.branchId, semId=state.semId;
  const q=(el('delSearch').value||'').trim().toLowerCase();
  const box=el('delResults');
  if(!q){ box.innerHTML=''; return; }
  const matches = recordsOf(branchId, semId).filter(r=>{
    const s=getStudent(r.studentId); if(!s) return false;
    return s.name.toLowerCase().includes(q) || (s.code||'').toLowerCase().includes(q);
  }).sort((a,b)=>{
    const sa=getStudent(a.studentId), sb=getStudent(b.studentId);
    return (sa?sa.name:'').localeCompare(sb?sb.name:'','ko');
  });
  if(matches.length===0){ box.innerHTML=`<div class="wd-empty">검색 결과가 없습니다</div>`; return; }
  box.innerHTML = matches.slice(0,30).map(r=>{
    const s=getStudent(r.studentId);
    const st = r.status==='withdraw' ? '<span class="status-badge withdraw">퇴원</span>' : '';
    return `<div class="wd-item" onclick="confirmDeleteOneStudent('${r.id}')">
      <div class="wd-main"><span class="wd-name">${esc(s.name)}</span><span class="code-chip">${esc(s.code)}</span> ${st}</div>
      <div class="wd-meta">${esc(r.classLabel||r.className)} · ${esc(r.teacher)} 담임</div>
    </div>`;
  }).join('');
}
function confirmDeleteOneStudent(recId){
  if(isPastSemester(state.semId)){ lockedPastToast(); return; }
  const rec=db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s=getStudent(rec.studentId);
  const histCnt = db.counselingHistories.filter(c=>c.studentId===rec.studentId && c.branchId===rec.branchId && c.semesterId===rec.semesterId).length;
  openConfirm('학생 삭제',
    `${s.name} (${s.code}) · ${rec.classLabel||rec.className}\n이 학생의 명단 기록${histCnt?`과 상담이력 ${histCnt}건`:''}이 삭제됩니다. 되돌릴 수 없습니다.`,
    ()=>{
      db.semesterRecords = db.semesterRecords.filter(r=>r.id!==recId);
      db.counselingHistories = db.counselingHistories.filter(c=>!(c.studentId===rec.studentId && c.branchId===rec.branchId && c.semesterId===rec.semesterId));
      db.studentMovements = (db.studentMovements||[]).filter(m=>!(m.studentId===rec.studentId && m.branchId===rec.branchId && m.semesterId===rec.semesterId));
      saveDB(); closeModal(); toast(`${s.name} 삭제 완료`,'ok'); render();
    });
}

/* 전체명단 삭제 (상담이력은 유지) */
function confirmClearRoster(){
  const branchId=session.branchId, semId=state.semId;
  if(isPastSemester(semId)){ lockedPastToast(); return; }
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
      <!-- ===== 왼쪽 위: 신규생 추가 ===== -->
      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--brand-soft);color:var(--brand)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M19 8v6M22 11h-6"/></svg>
          </div>
          <div><h3>신규생 추가</h3></div>
        </div>
        <div class="pd">학기 중 입학한 학생을 수동 등록합니다. 신규생은 HC1·HC2 대상이며, MC는 입학일 기준으로 그 달부터의 회차만 대상이 됩니다. (예: 여름학기 7월 입학 → MC1 제외, MC2·MC3 대상)</div>
        <div class="form-row">
          <div class="field"><label>학생명</label><input id="nsName" placeholder="이름" oninput="refreshMsg()"></div>
          <div class="field"><label>회원코드</label><input id="nsCode" placeholder="코드"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>학교</label><input id="nsSchool" placeholder="학교" oninput="refreshMsg()"></div>
          <div class="field"><label>학년</label>
            <select id="nsGrade" onchange="refreshMsg()">
              <option value="">학년 선택…</option>
              <option value="초등1">초등1</option>
              <option value="초등2">초등2</option>
              <option value="초등3">초등3</option>
              <option value="초등4">초등4</option>
              <option value="초등5">초등5</option>
              <option value="초등6">초등6</option>
              <option value="중등1">중등1</option>
              <option value="중등2">중등2</option>
              <option value="중등3">중등3</option>
            </select>
          </div>
        </div>
<div class="form-row">
          <div class="field full"><label>반 선택 (검색 가능 · 레벨·반명·담임으로)</label>
            <input id="nsClassSearch" placeholder="반 검색… (예: PA2, 월수금, 담임명)" autocomplete="off"
              oninput="renderNsClassResults()" onfocus="renderNsClassResults()">
            <div id="nsClassResults" class="wd-results" style="display:none"></div>
            <div id="nsClassPicked" class="wd-picked" style="display:none"></div>
            <select id="nsClassSelect" style="display:none">
              <option value="">기존 반에서 선택…</option>
              ${classList.map(c=>`<option value="${esc(c.className)}" data-teacher="${esc(c.teacher)}">${esc(c.label)} · ${esc(c.teacher)}</option>`).join('')}
              <option value="__new__">+ 새 반 직접 입력</option>
            </select>
          </div>
        </div>
        <div class="form-row" id="nsNewClassRow" style="display:none">
          <div class="field"><label>새 반명 (엑셀과 동일하게)</label><input id="nsClass" placeholder="예: [DSC2]SU1/MWF/DSC2/H" oninput="refreshMsg()"></div>
          <div class="field"><label>담임명</label><input id="nsTeacher" placeholder="담임" oninput="refreshMsg()"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>입학일 (등원일)</label><input id="nsDate" type="date" oninput="refreshMsg()"></div>
          <div class="field"><label>메모 (선택)</label><input id="nsMemo" placeholder="예: 운정1에서 전입"></div>
        </div>
        <label class="wd-transfer" style="margin-bottom:10px"><input type="checkbox" id="nsTransferIn" onchange="document.getElementById('nsTransferFromRow').style.display=this.checked?'flex':'none'"> <span>전입 (다른 분원에서 옴) — 신규생과 분리 집계</span></label>
        <div class="form-row" id="nsTransferFromRow" style="display:none">
          <div class="field full"><label>어느 분원에서 왔나요?</label>
            <select id="nsTransferFrom">
              <option value="">전 분원 선택…</option>
              ${db.branches.filter(x=>x.id!==branchId).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <button class="btn primary" style="width:100%" onclick="addNewStudent()">신규생 등록</button>
      </div>

      <!-- ===== 오른쪽 위: 신규생 문자 ===== -->
      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--brand-soft);color:var(--brand)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div><h3>신규생 안내 문자</h3></div>
        </div>
        <div class="pd">왼쪽에서 신규생 정보를 입력하면 문자가 실시간으로 채워집니다. 탭을 골라 복사하세요. 입력값은 저장되지 않습니다.</div>
        <div id="msgCardBody"></div>
      </div>

      <!-- ===== 왼쪽 아래: 퇴원 처리 ===== -->
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
        <div class="form-row" style="margin:10px 0">
          <div class="field"><label>퇴원일</label><input id="wdDate" type="date" value="${today()}"></div>
          <div class="field" id="wdReasonField">
        <label>퇴원 사유</label>
        <select id="wdReason" onchange="toggleWdReason()">
          <option value="">선택하세요</option>
          ${WITHDRAW_REASONS.map(r=>`<option value="${r.code}">${esc(r.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field full"><label>메모 (선택)</label><input id="wdMemo" placeholder="상세 내용을 적어주세요"></div>
        </div>
<label class="wd-transfer"><input type="checkbox" id="wdTransfer" onchange="document.getElementById('wdTransferToRow').style.display=this.checked?'flex':'none'; toggleWdReason()"> <span>전출 (다른 분원으로 이동) — 퇴원율에 반영하지 않음</span></label>
        <div class="form-row" id="wdTransferToRow" style="display:none;margin-top:8px">
          <div class="field full"><label>어느 분원으로 가나요? (본사 전입 대조용)</label>
            <select id="wdTransferTo">
              <option value="">전출 분원 선택…</option>
              ${db.branches.filter(x=>x.id!==branchId).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <button class="btn" style="width:100%;border-color:var(--neg-soft);color:var(--neg)" onclick="withdrawStudent()">퇴원 처리</button>
      </div>

      <!-- ===== 오른쪽 아래: 퇴원생 상태 변경 ===== -->
      <div class="panel">
        <div class="panel-head">
          <div class="pi" style="background:var(--warn-soft);color:var(--warn)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/></svg>
          </div>
          <div><h3>퇴원생 상태 변경</h3></div>
        </div>
        <div class="pd">이미 퇴원·전출 처리한 학생의 상태를 바꿉니다. <b>전출했다가 실제론 타학원 퇴원</b>이면 일반 퇴원으로, <b>잘못 퇴원시켰으면</b> 재원 복귀로 되돌립니다.</div>
        <div class="field full" style="margin-bottom:8px">
          <label>퇴원·전출 학생 검색 (이름 또는 회원코드)</label>
          <input id="wcSearch" placeholder="예: 김태양" autocomplete="off" oninput="renderWcResults()">
        </div>
        <div id="wcResults" class="wd-results"></div>
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-head">
        <div class="pi" style="background:var(--warn-soft);color:var(--warn)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11l-3 3-3-3"/></svg>
        </div>
        <div><h3>담임 변경</h3></div>
      </div>
      <div class="pd">반의 담임이 중간에 바뀐 경우 등록합니다. <b>변경일 이후</b>의 인원·퇴원은 새 담임 실적으로, 그 전은 이전 담임 실적으로 인원마감표에 반영됩니다.</div>
      <div class="form-row">
        <div class="field full"><label>반 선택</label>
          <select id="tcClass" onchange="onTcClassChange()">
            <option value="">반을 선택하세요…</option>
            ${classList.map(c=>`<option value="${esc(c.className)}" data-teacher="${esc(c.teacher)}">${esc(c.label)} · 현재담임 ${esc(c.teacher)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="field"><label>현재 담임</label><input id="tcFrom" placeholder="반 선택 시 자동" readonly></div>
        <div class="field"><label>새 담임</label><input id="tcTo" placeholder="새 담임명"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>변경일 (새 담임 수업 시작일)</label><input id="tcDate" type="date" value="${today()}"></div>
      </div>
      <button class="btn primary" style="width:100%" onclick="changeTeacher()">담임 변경 등록</button>
      ${(()=>{
        const changes = (db.teacherChanges||[]).filter(c=>c.branchId===branchId && c.semesterId===semId)
          .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
        if(!changes.length) return '';
        return `<div style="margin-top:16px"><div style="font-size:12px;font-weight:700;color:var(--ink-2);margin-bottom:8px">변경 이력</div>
          ${changes.map(c=>{
            const cls = classMap.get(c.className);
            const label = cls?cls.label:c.className;
            return `<div class="tc-hist">
              <span>${esc(label)}</span>
              <span class="tc-flow">${esc(c.fromTeacher)} → <b>${esc(c.toTeacher)}</b></span>
              <span class="tc-date num">${esc(c.date)}</span>
              <button class="tc-del" onclick="deleteTeacherChange('${c.id}')">변경 취소</button>
            </div>`;
          }).join('')}
        </div>`;
      })()}
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

  // 반 선택 드롭다운: '새 반 직접 입력' 고르면 입력칸 표시 + 문자 실시간 갱신
  const csel = el('nsClassSelect');
  if(csel){
    csel.onchange = ()=>{
      el('nsNewClassRow').style.display = csel.value==='__new__' ? 'flex' : 'none';
      renderMsgCard();  // 반 바뀌면 레벨·교재·담임 자동 반영 위해 카드 다시 그림
    };
  }
// 반 검색 결과 박스: 바깥 클릭 시 닫기
  document.addEventListener('click', (e)=>{
    const wrap = el('nsClassResults');
    const search = el('nsClassSearch');
    if(!wrap || !search) return;
    if(e.target!==search && !wrap.contains(e.target)) wrap.style.display='none';
  });
  // 문자 카드 최초 렌더
  renderMsgCard();
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
  rec.className=inClass;
  rec.classLabel=classLabel(inClass)||inClass;  // 원본 형식이면 깔끔한 라벨로 자동 변환
  rec.teacher=el('edTeacher').value.trim()||'미배정';
  rec.enrollDate=el('edDate').value;
  saveDB(); closeModal(); toast('수정 완료','ok'); render();
}
/* 수동 등록 학생 삭제 — 학기레코드 + 이동이력 제거 (상담이력은 보존) */
function confirmDeleteStudent(recId){
  if(isPastSemester(state.semId)){ lockedPastToast(); return; }
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

/* 반 이름이 실제 수업반인지 (대괄호로 시작하면 수업반).
   "[A2(1-3)]..." 처럼 대괄호 안에 괄호가 있어도 인식. 셔틀비 등 대괄호 없으면 제외 */
function isRealClass(raw){
  return /^\s*\[/.test(String(raw||''));
}
/* 반 종류 판별: 대괄호로 시작 → 정규반(regular), 대괄호 없이 "내신" 포함 → 내신반(exam), 그 외 → null(제외) */
function classKind(raw){
  const s = String(raw||'').trim();
  if(/^\[/.test(s)) return 'regular';
  if(s.includes('내신')) return 'exam';
  return null;
}
/* 반 이름에서 레벨 코드만 추출 (괄호 안 내용은 무시).
   "[PA1]SU3/..." → "PA1",  "[A2(1-3)]SM4/..." → "A2" */
function classLevel(raw){
  const m = String(raw||'').match(/^\s*\[([A-Za-z]+[0-9]*)/);  // 대괄호 직후 영문+숫자 = 레벨
  return m ? m[1] : '';
}
/* 학생의 '학년' 칸에서 표준 학년키 추출 → '초1'~'초6','중1'~'중3' (없으면 '') .
   "초등6","초6","6학년","중등2","중2" 등 다양한 표기 흡수. */
function gradeKey(s){
  const g = String((s&&s.grade)||'').replace(/\s/g,'');
  if(!g) return '';
  // 중등 먼저
  let m = g.match(/중(?:등)?\s*([1-3])/);
  if(m) return '중'+m[1];
  m = g.match(/초(?:등)?\s*([1-6])/);
  if(m) return '초'+m[1];
  // 숫자만 있는 경우는 판단 불가(초/중 모름) → 빈값
  return '';
}
/* 학년키 → 초등/중등 구분 (학년 기준: 초1~5=초등, 초6~중3=중등) */
function gradeBand(key){
  if(/^초[1-5]$/.test(key)) return '초등';
  if(/^초6$/.test(key) || /^중[1-3]$/.test(key)) return '중등';
  return '기타';
}
/* 정렬용 학년 순서 */
function gradeOrder(key){
  const map={'초1':1,'초2':2,'초3':3,'초4':4,'초5':5,'초6':6,'중1':7,'중2':8,'중3':9};
  return map[key]||99;
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
  if(isPastSemester(semId)){ lockedPastToast(); return; }
  readTable(file, async rows=>{
    if(rows.length<2){ toast('데이터가 없습니다','err'); return; }
    const HDR = {
      name:['이름','학생명','성명'],
      code:['회원코드','코드','학생코드'],
      school:['학교'],
      grade:['학년'],
      cls:['반 이름','반이름','반명','반','클래스'],
      teacher:['담임선생님','담임명','담임','선생님'],
      note:['특이사항','비고','메모'],
      startdate:['반 시작일','반시작일','시작일','등원일','입학일']
    };
    // 맨 위 병합 제목행이 있어도 자동으로 건너뜀 — 최대 3행 탐색
    let idx = null;
    for(let i=0; i<Math.min(3, rows.length-1); i++){
      const cand = mapHeader(rows[i].map(h=>String(h).trim()), HDR);
      if(cand.name>=0 && cand.code>=0){ idx = cand; rows = rows.slice(i); break; }
    }
    if(!idx){ toast('이름·회원코드 열을 찾지 못했습니다','err'); return; }
    let added=0, updated=0, excluded=0, examAdded=0;
    rows.slice(1).forEach(r=>{
      const name=String(r[idx.name]||'').trim();
      const code=String(r[idx.code]||'').trim();
      if(!name||!code) return;
      const rawClass = idx.cls>=0 ? String(r[idx.cls]||'').trim() : '';
      const kind = classKind(rawClass);     // 'regular' | 'exam' | null
      if(!kind){ excluded++; return; }       // 대괄호도 '내신'도 아니면 제외
      const classFull = rawClass;
      const classLbl = kind==='exam' ? rawClass : classLabel(rawClass);  // 내신반은 이름 그대로 표시
      const note = idx.note>=0 ? String(r[idx.note]||'').trim() : '';
      // '복귀' 글자 있으면 복귀, 없고 '신규'만 있으면 신규. 둘 다 섞여 있어도 복귀 우선.
      // (복귀생도 신규로 카운트되지만, 특이사항/배지엔 '복귀'로 구분 표시됨)
      const origin = /복귀/.test(note)?'return' : (/신규/.test(note)?'new' : 'start');
      const targetType = (origin==='new'||origin==='return')?'HCMC':'MC';
      const teacher = String(r[idx.teacher]||'').trim() || '미배정';
      const school = idx.school>=0 ? String(r[idx.school]||'').trim() : '';
      const grade  = idx.grade>=0 ? String(r[idx.grade]||'').trim() : '';
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
      // 학기레코드 upsert — ★ kind까지 일치해야 같은 레코드 (정규/내신 별개 공존)
      let rec = db.semesterRecords.find(x=>x.studentId===stu.id && x.branchId===branchId && x.semesterId===semId && (x.kind||'regular')===kind);
      if(!rec){
        rec={id:uid('rec'),studentId:stu.id,branchId,semesterId:semId,
          className:classFull,classLabel:classLbl,teacher,note,targetType,status:'active',origin,enrollDate,kind};
        db.semesterRecords.push(rec);
        if(kind==='exam'){ examAdded++; }
        else {
          added++;
          if(origin==='new') db.studentMovements.push({id:uid('mv'),studentId:stu.id,branchId,semesterId:semId,type:'new',date:enrollDate||today(),memo:'명단 업로드'});
          if(origin==='return') db.studentMovements.push({id:uid('mv'),studentId:stu.id,branchId,semesterId:semId,type:'return',date:enrollDate||today(),memo:'명단 업로드'});
        }
      } else {
        rec.className=classFull; rec.classLabel=classLbl; rec.teacher=teacher;
        if(note) rec.note=note; rec.targetType=targetType;
        if(enrollDate) rec.enrollDate=enrollDate;
        if(rec.status==='withdraw') rec.status='active';
        updated++;
      }
    });
    showSaving(`전체명단 저장 중… (잠시만요)`);
    const ok = await saveDB();
    hideSaving();
    if(ok){
      toast(`✅ 저장 완료 · 정규 신규 ${added}, 갱신 ${updated}${examAdded?`, 내신반 ${examAdded}`:''}${excluded?`, 제외 ${excluded}`:''}`,'ok');
    } else {
      toast('❌ 저장 실패 — 다시 업로드해 주세요','err');
    }
    render();
  });
}

function importHistory(file, branchId, semId){
  readTable(file, async rows=>{
    if(rows.length<2){ toast('데이터가 없습니다','err'); return; }
    const HDR_MAP = {
      code:['회원코드','코드'],
      name:['이름','학생명'],
      category:['분류','구분'],
      content:['내용','상담내용','상담'],
      date:['날짜','상담일','일자'],
      status:['상태'],
      counselor:['상담자','담임','작성자']
    };
    // 첫 행이 병합 제목("상담이력")이면 다음 행을 헤더로 사용 — 최대 3행까지 탐색
    let headRow = -1, idx = null;
    for(let i=0; i<Math.min(3, rows.length-1); i++){
      const cand = mapHeader(rows[i].map(h=>String(h).trim()), HDR_MAP);
      if(cand.content>=0){ headRow = i; idx = cand; break; }
    }
    if(headRow<0){ toast('내용 열을 찾지 못했습니다','err'); return; }
    rows = rows.slice(headRow);
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
        const recForStu = db.semesterRecords.find(x=>x.studentId===stu.id && x.branchId===branchId && x.semesterId===semId);
        const timing = stageTimingCheck(type, date, semId, recForStu && recForStu.enrollDate);
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
    showSaving(`상담이력 저장 중… (${added}건, 잠시만요)`);
    const ok = await saveDB();
    hideSaving();
    let extra = '';
    if(prevSem>0) extra += `, 이전학기 제외 ${prevSem}`;
    if(misTagCnt>0) extra += `, 오기재 의심 ${misTagCnt}`;
    if(ok){
      toast(`✅ 저장 완료 · 추가 ${added}, 중복 ${dup}, 미매칭 ${skip}${extra}`,'ok');
    } else {
      toast('❌ 저장 실패 — 다시 업로드해 주세요 (서버에 저장되지 않았습니다)','err');
    }
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
const isTransferIn = el('nsTransferIn') ? el('nsTransferIn').checked : false;
  const fromBranchId = isTransferIn && el('nsTransferFrom') ? el('nsTransferFrom').value : '';
  const fromBranchName = fromBranchId ? (getBranch(fromBranchId)?.name||'') : '';
  db.semesterRecords.push({id:uid('rec'),studentId:stu.id,branchId,semesterId:semId,
    className,classLabel:classLbl,teacher,
    note:isTransferIn?'전입':'신규생',targetType:'HCMC',status:'active',origin:'new',transferIn:isTransferIn,transferTo:fromBranchId||null,enrollDate});
  const nsMemo = (el('nsMemo')?el('nsMemo').value.trim():'')
    || (isTransferIn?(fromBranchName?`${fromBranchName}에서 전입`:'전입 (수동 등록)'):'수동 등록');
  db.studentMovements.push({id:uid('mv'),studentId:stu.id,branchId,semesterId:semId,type:'new',date:enrollDate,memo:nsMemo});
// 등록한 학생 정보를 문자 카드에 복원하기 위해 저장 (리렌더 후에도 문자 유지)
  msgState.locked = readNsForm();
  saveDB(); toast(`${name} ${isTransferIn?'전입':'신규생'} 등록 완료 — 오른쪽에서 안내 문자를 복사하세요`,'ok'); render();
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
function toggleWdReason(){
  const isTransfer = el('wdTransfer') ? el('wdTransfer').checked : false;
  const f = el('wdReasonField');
  if(f) f.style.display = isTransfer ? 'none' : '';
}
function withdrawStudent(){
  const recId=el('wdSelect').value;
  if(!recId){ toast('학생을 검색해서 선택하세요','err'); return; }
  const rec=db.semesterRecords.find(r=>r.id===recId);
  if(!rec){ toast('학생을 다시 선택하세요','err'); return; }
  const wdDate = el('wdDate').value || today();
  const isTransfer = el('wdTransfer') ? el('wdTransfer').checked : false;
  const toBranchId = isTransfer && el('wdTransferTo') ? el('wdTransferTo').value : '';
  if(isTransfer && !toBranchId){ toast('전출 대상 분원을 선택하세요','err'); return; }

  const reason = (!isTransfer && el('wdReason')) ? el('wdReason').value : '';
  if(!isTransfer && !reason){ toast('퇴원 사유를 선택하세요','err'); return; }

  const toBranchName = toBranchId ? (getBranch(toBranchId)?.name||'') : '';
  rec.status='withdraw';
  rec.withdrawDate=wdDate;
  rec.transfer=isTransfer;
  rec.transferTo=toBranchId||null;
rec.withdrawReason = isTransfer ? null : reason;

  const memo = el('wdMemo').value.trim();
  rec.withdrawMemo = memo;
  const stu=getStudent(rec.studentId);
  db.studentMovements.push({id:uid('mv'),studentId:rec.studentId,branchId:rec.branchId,semesterId:rec.semesterId,
    type:'withdraw',date:wdDate,
    memo:(isTransfer?`[전출→${toBranchName}] `:`[${wdReasonLabel(reason)}] `)+(memo||'퇴원 처리')});
  saveDB(); toast(`${stu.name} ${isTransfer?`${toBranchName}로 전출`:'퇴원'} 처리 완료`,'ok'); render();
}

/* 퇴원·전출 학생 검색 (상태 변경용) */
function renderWcResults(){
  const branchId=session.branchId, semId=state.semId;
  const q = (el('wcSearch').value||'').trim().toLowerCase();
  const box = el('wcResults');
  if(!q){ box.innerHTML=''; return; }
  const matches = recordsOf(branchId, semId).filter(r=>{
    if(r.status!=='withdraw') return false;  // 퇴원·전출 학생만
    const s=getStudent(r.studentId); if(!s) return false;
    return s.name.toLowerCase().includes(q) || (s.code||'').toLowerCase().includes(q);
  }).sort((a,b)=>{
    const sa=getStudent(a.studentId), sb=getStudent(b.studentId);
    return (sa?sa.name:'').localeCompare(sb?sb.name:'','ko');
  });
  if(matches.length===0){ box.innerHTML=`<div class="wd-empty">퇴원·전출 학생 중 검색 결과가 없습니다</div>`; return; }
  box.innerHTML = matches.slice(0,30).map(r=>{
    const s=getStudent(r.studentId);
    const badge = r.transfer
      ? '<span class="status-badge" style="background:var(--warn-soft);color:var(--warn)">전출</span>'
      : '<span class="status-badge withdraw">퇴원</span>';
    return `<div class="wd-item" style="cursor:default">
      <div class="wd-main"><span class="wd-name">${esc(s.name)}</span><span class="code-chip">${esc(s.code)}</span> ${badge}</div>
      <div class="wd-meta">${esc(r.classLabel||r.className)} · ${esc(r.teacher)} 담임 · ${esc(r.withdrawDate||'')}</div>
<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        ${r.transfer
          ? `<button class="btn sm" style="border-color:var(--neg-soft);color:var(--neg)" onclick="convertWithdrawType('${r.id}',false)">→ 일반 퇴원으로</button>`
          : `<button class="btn sm" style="border-color:var(--warn-soft);color:var(--warn)" onclick="convertWithdrawType('${r.id}',true)">→ 전출로</button>`}
        <button class="btn sm" onclick="openEditWithdrawReason('${r.id}')">사유 수정</button>
        <button class="btn sm" style="border-color:var(--pos-soft);color:var(--pos)" onclick="restoreStudent('${r.id}')">재원 복귀</button>
      </div>
    </div>`;
  }).join('');
}
/* 전출 ↔ 일반 퇴원 전환. 전출로 바꿀 땐 목적지 분원을 골라야 함(본사 매칭용). */
function convertWithdrawType(recId, toTransfer){
  const rec=db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s=getStudent(rec.studentId);

  // 일반 퇴원으로 되돌리는 건 분원 선택 불필요 — 바로 확인
  if(!toTransfer){
    openConfirm('퇴원 종류 변경',
      `${s.name} (${s.code})을 일반 퇴원으로 변경합니다.\n\n일반 퇴원은 퇴원율에 반영됩니다.`,
      ()=>{
        rec.transfer = false;
        rec.transferTo = null;
        const mv = db.studentMovements.find(m=>m.studentId===rec.studentId && m.branchId===rec.branchId && m.semesterId===rec.semesterId && m.type==='withdraw');
        if(mv){ mv.memo = (mv.memo||'').replace(/^\[전출[^\]]*\]\s*/,'') || '퇴원 처리'; }
        showSaving('변경 중…');
        saveDB().then(ok=>{ hideSaving(); closeModal();
          toast(ok?`${s.name} 일반 퇴원으로 변경됨`:'저장 실패','ok'); render(); });
      }, {yesLabel:'변경', danger:false});
    return;
  }

  // 전출로 바꿀 땐 목적지 분원 드롭다운이 든 모달
  const branchId = rec.branchId;
  openModal(`
    <div class="modal-head"><div><h3>전출로 변경</h3>
      <div class="mh-sub">${esc(s.name)} (${esc(s.code)})</div></div>
      <button class="modal-x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin-bottom:12px">전출은 퇴원율 계산에서 제외됩니다. 어느 분원으로 가는지 선택하면 본사에서 전입과 대조할 수 있습니다.</p>
      <div class="field full"><label>전출 대상 분원</label>
        <select id="ctTransferTo">
          <option value="">전출 분원 선택…</option>
          ${db.branches.filter(x=>x.id!==branchId).map(x=>`<option value="${x.id}" ${rec.transferTo===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">취소</button>
      <button class="btn primary" id="ctSave">전출로 변경</button>
    </div>`);
  el('ctSave').onclick = ()=>{
    const toBranchId = el('ctTransferTo').value;
    if(!toBranchId){ toast('전출 대상 분원을 선택하세요','err'); return; }
    const toBranchName = getBranch(toBranchId)?.name||'';
    rec.transfer = true;
    rec.transferTo = toBranchId;
    const mv = db.studentMovements.find(m=>m.studentId===rec.studentId && m.branchId===rec.branchId && m.semesterId===rec.semesterId && m.type==='withdraw');
    if(mv){ mv.memo = `[전출→${toBranchName}] ` + (mv.memo||'').replace(/^\[전출[^\]]*\]\s*/,''); }
    showSaving('변경 중…');
    saveDB().then(ok=>{ hideSaving(); closeModal();
      toast(ok?`${s.name} ${toBranchName}로 전출 변경됨`:'저장 실패','ok'); render(); });
  };
}
/* 재원 복귀 — 잘못 퇴원시킨 학생 되돌리기 */
function restoreStudent(recId){
  const rec=db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s=getStudent(rec.studentId);
  openConfirm('재원 복귀',
    `${s.name} (${s.code})을 다시 재원 상태로 되돌립니다.\n\n퇴원·전출 기록이 취소되고 현재 재원생에 다시 포함됩니다.`,
    ()=>{
      rec.status = 'active';
      rec.withdrawDate = null;
      rec.transfer = false;
      // 퇴원 이동이력 제거
      db.studentMovements = db.studentMovements.filter(m=>!(m.studentId===rec.studentId && m.branchId===rec.branchId && m.semesterId===rec.semesterId && m.type==='withdraw'));
      showSaving('복귀 중…');
      saveDB().then(ok=>{ hideSaving(); closeModal();
        toast(ok?`${s.name} 재원 복귀 완료`:'저장 실패','ok'); render(); });
    }, {yesLabel:'재원 복귀', danger:false});
}
/* 퇴원/전출 사유 수정 — 이동이력 메모에서 [전출→분원] 표시는 보존하고 사유 부분만 교체 */
function openEditWithdrawReason(recId){
  const rec = db.semesterRecords.find(r=>r.id===recId);
  if(!rec) return;
  const s = getStudent(rec.studentId);
  const mv = db.studentMovements.find(m=>m.studentId===rec.studentId && m.branchId===rec.branchId && m.semesterId===rec.semesterId && m.type==='withdraw');
  // 현재 메모에서 [전출→…] 접두사 떼고 순수 사유만 뽑음
  const rawMemo = (mv && mv.memo) || '';
  const prefixMatch = rawMemo.match(/^(\[전출[^\]]*\]\s*)/);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  let curReason = rawMemo.replace(/^\[전출[^\]]*\]\s*/,'');
  if(curReason==='퇴원 처리') curReason = '';  // 기본 메모면 빈칸으로 보여줌

  openModal(`
    <div class="modal-head"><div><h3>퇴원 사유 수정</h3>
      <div class="mh-sub">${esc(s.name)} (${esc(s.code)})${rec.transfer?' · 전출':''}</div></div>
      <button class="modal-x" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="field full"><label>퇴원${rec.transfer?'/전출':''} 사유</label>
        <input id="ewReason" placeholder="예: 타지역 이사" value="${esc(curReason)}">
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">취소</button>
      <button class="btn primary" id="ewSave">저장</button>
    </div>`);
  el('ewSave').onclick = ()=>{
    const reason = el('ewReason').value.trim() || '퇴원 처리';
    if(mv){
      mv.memo = prefix + reason;
    } else {
      // 이동이력이 없으면 새로 만들어줌
      db.studentMovements.push({id:uid('mv'),studentId:rec.studentId,branchId:rec.branchId,semesterId:rec.semesterId,
        type:'withdraw',date:rec.withdrawDate||today(),memo:prefix+reason});
    }
    showSaving('사유 수정 중…');
    saveDB().then(ok=>{ hideSaving(); closeModal();
      toast(ok?`${s.name} 사유 수정됨`:'저장 실패','ok'); render(); });
  };
}
/* 담임 변경 — 반 선택 시 현재 담임 자동 표시 */
function onTcClassChange(){
  const sel = el('tcClass');
  const opt = sel.options[sel.selectedIndex];
  el('tcFrom').value = opt ? (opt.dataset.teacher||'') : '';
}
/* 담임 변경 등록 — 반 학생들 담임 교체 + 변경 이력 저장 */
function changeTeacher(){
  const branchId = session.branchId, semId = state.semId;
  const className = el('tcClass').value;
  const toTeacher = el('tcTo').value.trim();
  const date = el('tcDate').value || today();
  if(!className){ toast('반을 선택하세요','err'); return; }
  if(!toTeacher){ toast('새 담임명을 입력하세요','err'); return; }
  const fromTeacher = el('tcFrom').value.trim();
  if(fromTeacher===toTeacher){ toast('현재 담임과 새 담임이 같습니다','err'); return; }
  // 변경 이력 저장
  db.teacherChanges.push({ id:uid('tc'), branchId, semesterId:semId, className,
    fromTeacher, toTeacher, date });
  // 해당 반 모든 레코드(재원·퇴원 포함)의 현재 담임을 새 담임으로 갱신
  // (인원마감표는 teacherChanges 이력으로 월별 실적을 쪼개므로, 현재 담임은 최신값으로 둠)
  recordsOf(branchId, semId).forEach(r=>{
    if(r.className===className) r.teacher = toTeacher;
  });
  showSaving('담임 변경 저장 중…');
  saveDB().then(ok=>{
    hideSaving();
    toast(ok?`담임 변경 완료 · ${fromTeacher} → ${toTeacher}`:'저장 실패, 다시 시도하세요', ok?'ok':'err');
    render();
  });
}
function deleteTeacherChange(id){
  const ch = db.teacherChanges.find(c=>c.id===id);
  if(!ch) return;
  const cls = (db.semesterRecords||[]).find(r=>r.className===ch.className && r.branchId===ch.branchId && r.semesterId===ch.semesterId);
  const label = cls ? (cls.classLabel||ch.className) : ch.className;
  openConfirm('담임 변경 취소',
    `「${label}」의 담임 변경(${ch.fromTeacher} → ${ch.toTeacher})을 취소할까요?\n\n이 반의 담임이 이전 담임(${ch.fromTeacher})으로 되돌아갑니다.`,
    ()=>{
      // 이 반 학생들 담임을 변경 전으로 원복
      (db.semesterRecords||[]).forEach(r=>{
        if(r.className===ch.className && r.branchId===ch.branchId && r.semesterId===ch.semesterId){
          r.teacher = ch.fromTeacher;
        }
      });
      db.teacherChanges = db.teacherChanges.filter(c=>c.id!==id);
      showSaving('변경 취소 중…');
      saveDB().then(ok=>{ hideSaving(); closeModal();
        toast(ok?`담임 변경 취소됨 · ${ch.toTeacher} → ${ch.fromTeacher}`:'저장 실패, 다시 시도하세요', ok?'ok':'err');
        render();
      });
    }, {yesLabel:'변경 취소'});
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
   17-2. 분원 — 선생님 계정 관리 (전체명단 담임 드롭다운으로 생성)
   ============================================================================ */
function renderTeacherAccounts(){
  const branchId = session.branchId;
  const b = getBranch(branchId);
  const semId = state.semId;
  crumbs([{label:'선생님·조교 계정'}]);
 
  // 이 분원 이번 학기 전체명단에 등록된 담임 이름 목록 (선생님 계정 드롭다운용)
  const teacherNames = [...new Set(
    activeRecordsOf(branchId, semId).map(r=>r.teacher).filter(t=>t && t!=='미배정')
  )].sort((a,b)=>a.localeCompare(b,'ko'));
 
  const teacherUsers = db.users.filter(u=>u.role==='teacher' && u.branchId===branchId);
  const assistantUsers = db.users.filter(u=>u.role==='assistant' && u.branchId===branchId);
 
  el('content').innerHTML = `
    <div class="page-head"><h2>선생님·조교 계정</h2>
      <div class="sub">${esc(b.name)} · 선생님은 자기 반 상담 현황을, 조교는 STaRT 외출관리만 볼 수 있습니다.</div></div>
 
    <!-- ===== 선생님 계정 ===== -->
    <div class="panel" style="margin-bottom:16px">
      <h3 style="font-size:14.5px;font-weight:650;margin-bottom:14px">새 선생님 계정 생성</h3>
      <div class="acct-add">
        <div class="field"><label>담임 선생님</label>
          <select id="tcAcctName">
            <option value="">전체명단에서 선택…</option>
            ${teacherNames.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')}
          </select></div>
        <div class="field"><label>아이디</label><input id="tcAcctUser" placeholder="영문 아이디"></div>
        <div class="field"><label>비밀번호</label><input id="tcAcctPw" placeholder="비밀번호"></div>
        <button class="btn primary" onclick="createTeacherAccount()">계정 생성</button>
      </div>
      ${teacherNames.length===0?`<div class="pd" style="margin-top:10px;color:var(--neg)">이번 학기 전체명단이 업로드되어야 담임 목록이 나옵니다. 먼저 데이터관리에서 명단을 올려주세요.</div>`:''}
    </div>
    <div class="table-wrap" style="margin-bottom:24px">
      <div class="table-scroll"><table class="grid">
        <thead><tr><th>담임</th><th>담당 반</th><th>아이디</th><th>비밀번호</th><th class="cc">관리</th></tr></thead>
        <tbody>
          ${teacherUsers.length===0?`<tr><td colspan="5" style="padding:16px;color:var(--ink-3);text-align:center">아직 만든 선생님 계정이 없습니다.</td></tr>`:
          teacherUsers.map(u=>{
            const clsCnt = new Set(activeRecordsOf(branchId, semId).filter(r=>r.teacher===u.teacherName).map(r=>r.className)).size;
            return `<tr>
              <td><b>${esc(u.teacherName||'(미지정)')}</b></td>
              <td>${clsCnt}개 반</td>
              <td><span class="code-chip">${esc(u.username)}</span></td>
              <td style="color:var(--ink-3)">${esc(u.password)}</td>
              <td class="cc"><button class="btn sm" style="color:var(--neg)" onclick="deleteAccount('${u.id}')">삭제</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>
 
    <!-- ===== 조교 계정 ===== -->
    <div class="panel" style="margin-bottom:16px">
      <h3 style="font-size:14.5px;font-weight:650;margin-bottom:4px">새 조교 계정 생성</h3>
      <div class="pd" style="margin-bottom:14px">조교 계정으로 로그인하면 <b>STaRT 외출관리 화면만</b> 보입니다. (다른 메뉴는 보이지 않습니다)</div>
      <div class="acct-add">
        <div class="field"><label>조교 이름</label><input id="asAcctName" placeholder="예: 김조교"></div>
        <div class="field"><label>아이디</label><input id="asAcctUser" placeholder="영문 아이디"></div>
        <div class="field"><label>비밀번호</label><input id="asAcctPw" placeholder="비밀번호"></div>
        <button class="btn primary" onclick="createAssistantAccount()">계정 생성</button>
      </div>
    </div>
    <div class="table-wrap">
      <div class="table-scroll"><table class="grid">
        <thead><tr><th>조교</th><th>아이디</th><th>비밀번호</th><th class="cc">관리</th></tr></thead>
        <tbody>
          ${assistantUsers.length===0?`<tr><td colspan="4" style="padding:16px;color:var(--ink-3);text-align:center">아직 만든 조교 계정이 없습니다.</td></tr>`:
          assistantUsers.map(u=>`<tr>
              <td><b>${esc(u.teacherName||'(이름없음)')}</b></td>
              <td><span class="code-chip">${esc(u.username)}</span></td>
              <td style="color:var(--ink-3)">${esc(u.password)}</td>
              <td class="cc"><button class="btn sm" style="color:var(--neg)" onclick="deleteAccount('${u.id}')">삭제</button></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
}
 
/* ============================================================================
   [B] 조교 계정 생성 — createTeacherAccount 근처에 추가
   ============================================================================ */
function createAssistantAccount(){
  const branchId = session.branchId;
  const name = el('asAcctName').value.trim();
  const user = el('asAcctUser').value.trim(), pw = el('asAcctPw').value.trim();
  if(!name){ toast('조교 이름을 입력하세요','err'); return; }
  if(!user||!pw){ toast('아이디와 비밀번호를 입력하세요','err'); return; }
  if(db.users.some(u=>u.username===user)){ toast('이미 존재하는 아이디입니다','err'); return; }
  db.users.push({ id:uid('u'), username:user, password:pw, role:'assistant', branchId, teacherName:name });
  saveDB(); toast(`${name} 조교 계정 생성 완료`,'ok'); render();
}
 
 
/* ============================================================================
   [C] STaRT 기록 표 — 삭제 버튼 추가. start_module.js의 startRenderLog 교체
   ============================================================================ */
function startRenderLog(){
  const body = el('stLogBody'); if(!body) return;
  el('stLogCount').textContent = startState.logRows.length+'명';
  body.innerHTML = startState.logRows.map(r=>{
    const elapsed = r.returnedAt ? Math.round((new Date(r.returnedAt)-new Date(r.leftAt))/1000) : null;
    const over = elapsed!=null && elapsed > r.limitSec;
    return `<tr>
      <td class="st-name">${esc(r.name)}</td>
      <td>${esc(r.cls||'—')}</td>
      <td>${esc(r.teacher||'—')}</td>
      <td class="num">${startHM(r.leftAt)}</td>
      <td class="num">${r.returnedAt?startHM(r.returnedAt):'—'}</td>
      <td class="num">${elapsed!=null?startDur(elapsed):'—'}</td>
      <td style="font-weight:700;color:${over?'var(--neg)':'var(--pos)'}">${over?'초과':'정상'}</td>
      <td class="cc"><button class="btn sm" style="color:var(--neg)" onclick="startDeleteLog('${r.id}')">삭제</button></td>
    </tr>`;
  }).join('');
}
 
/* ============================================================================
   [D] STaRT 기록 삭제 — start_module.js 아무 데나(함수 밖) 추가
   ============================================================================ */
async function startDeleteLog(id){
  const r = startState.logRows.find(x=>x.id===id);
  if(!r) return;
  if(!confirm(`${r.name} 학생의 이 기록을 삭제할까요?`)) return;
  const { error } = await sb.from('start_sessions').delete().eq('id', id);
  if(error){ console.error(error); toast('삭제 실패','err'); return; }
  startState.logRows = startState.logRows.filter(x=>x.id!==id);
  startRenderLog();
  toast('기록 삭제됨','ok');
}
function createTeacherAccount(){
  const branchId = session.branchId;
  const tname = el('tcAcctName').value;
  const user = el('tcAcctUser').value.trim(), pw = el('tcAcctPw').value.trim();
  if(!tname){ toast('담임 선생님을 선택하세요','err'); return; }
  if(!user||!pw){ toast('아이디와 비밀번호를 입력하세요','err'); return; }
  if(db.users.some(u=>u.username===user)){ toast('이미 존재하는 아이디입니다','err'); return; }
  db.users.push({ id:uid('u'), username:user, password:pw, role:'teacher', branchId, teacherName:tname });
  saveDB(); toast(`${tname} 선생님 계정 생성 완료`,'ok'); render();
}

/* ============================================================================
   17-3. 선생님 — 내 반 현황 (담임 대시보드: 자기 반만)
   ============================================================================ */
function renderTeacherHome(){
  const branchId = session.branchId;
  const teacher = session.teacherName;
  const b = getBranch(branchId);
  const semId = state.semId;
  state.viewBranchId = branchId;  // 반 상세에서 activeBranchId가 이 분원을 보도록
  crumbs([{label:`${b?b.name:''} 내 반 현황`}]);

  if(!teacher){
    el('content').innerHTML = emptyState('담당 담임이 연결되지 않았습니다','분원 관리자에게 계정 설정을 요청하세요.');
    return;
  }

const trecs = activeRecordsOf(branchId, semId).filter(r=>r.teacher===teacher);
  const examTrecs = examRecordsOf(branchId, semId).filter(r=>r.teacher===teacher);
  if(trecs.length===0){
    el('content').innerHTML = `
      <div class="page-head"><h2>${esc(teacher)} 선생님</h2>
        <div class="sub">${esc(b?b.name:'')} · ${esc(db.semesters.find(s=>s.id===semId)?.name||'')}</div></div>
      ${emptyState('이번 학기 담당 반이 없습니다','전체명단이 업로드되면 담당 반이 표시됩니다.')}`;
    return;
  }

const rates = calcRates(rateRecordsOfTeacher(branchId, semId, teacher), branchId, semId);
  const classes = classesOf(branchId, semId, teacher);

  let html = `
    <div class="page-head">
      <h2>${esc(teacher)} <span style="font-size:14px;font-weight:500;color:var(--ink-3)">선생님</span></h2>
      <div class="sub">${esc(b?b.name:'')} · 학생 ${trecs.length}명 · 반 ${classes.length}개 · ${esc(db.semesters.find(s=>s.id===semId)?.name||'')}</div>
    </div>
    <div class="sect-head"><h3>전체 상담 진행률</h3></div>
    ${ratePanel(rates)}
    <div class="sect-head"><h3>담당 반 목록</h3>
      <div class="sort-bar">
        ${classSortBtn('rate_desc','상담률 높은순')}
        ${classSortBtn('rate_asc','낮은순')}
        ${classSortBtn('name','반이름순')}
      </div></div>
    <div class="card-grid g4">`;

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

  // 내신반 (이 선생님이 내신담임인 반)
  if(examTrecs.length>0){
    const examClassMap = new Map();
    examTrecs.forEach(r=>{ if(!examClassMap.has(r.className)) examClassMap.set(r.className,[]); examClassMap.get(r.className).push(r); });
    const examCards = [...examClassMap.entries()].map(([className, crecs])=>{
      const rates = calcRates(crecs, branchId, semId);
      return `<div class="card clickable" onclick="go('branch/class/${encodeURIComponent(teacher)}/${encodeURIComponent(className)}')">
        <div class="card-top">
          <div><div class="card-name">${esc(className)}</div>
            <div class="card-sub">학생 ${crecs.length}명 <span style="color:var(--warn)">(내신반)</span></div></div>
          <div class="card-rate"><div class="r num" style="color:${rateColor(rates.totalRate)}">${rates.totalTarget?rates.totalRate+'%':'–'}</div>
            <div class="rl">내신 MC</div></div>
        </div>
        <div class="card-foot"><span class="incomplete-tag">내신반</span>${goArrow}</div>
      </div>`;
    }).join('');
    html += `<div class="sect-head"><h3>내신반</h3></div><div class="card-grid g4">${examCards}</div>`;
    el('content').innerHTML = html;
  } else {
    el('content').innerHTML = html;
  }
}
/* ============================================================================
   17-4. 분원 — 세그먼트 공지 입력 (회차별 4섹션)
   ============================================================================ */
const WITHDRAW_REASONS = [
  { code:'academy',   label:'타학원 이동' },
  { code:'personal',  label:'개인 사유' },
  { code:'burden',    label:'학습 부담' },
  { code:'teacher',   label:'담임 불만' },
  { code:'peer',      label:'교우 관계' },
  { code:'schedule',  label:'스케줄' },
  { code:'moving',    label:'이사' },
  { code:'graduate',  label:'졸업' },
  { code:'closed',    label:'폐강' },
  { code:'other',     label:'기타' },
];
function wdReasonLabel(code){
  const f = WITHDRAW_REASONS.find(r=>r.code===code);
  return f ? f.label : '';
}
   const SEG_STAGES = ['MC1','MC2','MC3'];
const SEG_SECTIONS = [
  { key:'sec1', label:'중요상담', ph:'그 회차 상담의 핵심 메시지 (예: 몰입 상담 강조, 톤 지침 등)' },
  { key:'sec2', label:'레벨 학습 목표 및 학습내용 안내', ph:'CHESS/ACE 레벨별 학습목표·교재·시험 안내' },
  { key:'sec3', label:'학부모 의견 & 학생 적응 상황', ph:'담임이 학부모와 나눌 대화 포인트' },
  { key:'sec4', label:'공지사항', ph:'평가일, 방학, 행정 공지 등' },
];

function renderSegmentEdit(){
  const branchId = session.branchId;
  const b = getBranch(branchId);
  const semId = state.semId;
  const stage = state.segStage || 'MC1';
  crumbs([{label:'세그먼트 공지'}]);

  // 현재 분원·학기·회차의 세그먼트 찾기 (없으면 새로 만들 준비)
  const seg = (db.segments||[]).find(s=>s.branchId===branchId && s.semesterId===semId && s.stage===stage);

  const stageBtn = (st)=>`<button class="sb-btn ${stage===st?'on':''}" onclick="setSegStage('${st}')">${st}</button>`;

  el('content').innerHTML = `
    <div class="page-head">
      <h2>세그먼트 공지</h2>
      <div class="sub">${esc(b.name)} · ${esc(db.semesters.find(s=>s.id===semId).name)} · 세그먼트를 회차별로 입력하면, 담임 계정에서 바로 확인할 수 있습니다.
    </div>
    <div class="sort-bar" style="margin-bottom:16px">
      ${SEG_STAGES.map(stageBtn).join('')}
    </div>
    <div class="panel">
      <h3 style="font-size:14.5px;font-weight:700;margin-bottom:4px">${esc(db.semesters.find(s=>s.id===semId).name)} ${stage} Segment</h3>
      <div class="pd" style="margin-bottom:14px">${seg&&seg.updatedAt?`마지막 저장: ${esc(seg.updatedAt)}`:'아직 저장된 내용이 없습니다.'}</div>
      ${SEG_SECTIONS.map((sec,i)=>`
        <div class="field full" style="margin-bottom:14px">
          <label style="font-weight:700">${i+1}. ${esc(sec.label)}</label>
          <textarea id="seg_${sec.key}" rows="5" placeholder="${esc(sec.ph)}"
            style="width:100%;padding:10px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);font-family:inherit;font-size:13.5px;line-height:1.6;resize:vertical">${esc(seg?seg[sec.key]||'':'')}</textarea>
        </div>`).join('')}
      <button class="btn primary" style="width:100%" onclick="saveSegment()">${stage} 세그먼트 저장</button>
    </div>`;
}
function renderSegmentView(){
  const branchId = session.branchId;
  const semId = state.semId;
  const stage = state.segStage || 'MC1';
  crumbs([{label:'세그먼트'}]);

  const sem = db.semesters.find(s=>s.id===semId);
  const seg = (db.segments||[]).find(s=>s.branchId===branchId && s.semesterId===semId && s.stage===stage);

  const stageBtn = (st)=>`<button class="sb-btn ${stage===st?'on':''}" onclick="setSegStage('${st}')">${st}</button>`;

  const body = seg
    ? SEG_SECTIONS.map((sec,i)=>{
        const val = (seg[sec.key]||'').trim();
        return `
        <div class="seg-block">
          <div class="seg-label"><span class="seg-num">${i+1}</span>${esc(sec.label)}</div>
          ${val ? `<div class="seg-readonly">${esc(val)}</div>`
                : `<div class="seg-empty">내용이 없습니다.</div>`}
        </div>`;
      }).join('')
    : `<div class="seg-empty" style="text-align:center;padding:36px 0">아직 등록된 ${stage} 세그먼트가 없습니다.</div>`;

  el('content').innerHTML = `
    <div class="page-head">
      <h2>세그먼트</h2>
      <div class="sub">${esc(sem?sem.name:'')} · 회차별 상담 가이드입니다. 상담 전 확인해 주세요.</div>
    </div>
    <div class="sort-bar" style="margin-bottom:16px">
      ${SEG_STAGES.map(stageBtn).join('')}
    </div>
    <div class="panel">
      <h3 style="font-size:14.5px;font-weight:700;margin-bottom:4px">${esc(sem?sem.name:'')} ${stage} Segment</h3>
      <div class="pd" style="margin-bottom:18px">${seg&&seg.updatedAt?`최종 수정: ${esc(seg.updatedAt)}`:'—'}</div>
      ${body}
    </div>`;
}
function setSegStage(st){ state.segStage = st; render(); }
function saveSegment(){
  const branchId = session.branchId, semId = state.semId;
  const stage = state.segStage || 'MC1';
  let seg = (db.segments||[]).find(s=>s.branchId===branchId && s.semesterId===semId && s.stage===stage);
  const vals = {};
  SEG_SECTIONS.forEach(sec=>{ vals[sec.key] = el('seg_'+sec.key).value.trim(); });
  if(seg){
    Object.assign(seg, vals); seg.updatedAt = nowStamp();
  } else {
    seg = { id:uid('seg'), branchId, semesterId:semId, stage, ...vals, updatedAt:nowStamp() };
    (db.segments||(db.segments=[])).push(seg);
  }
  showSaving('세그먼트 저장 중…');
  saveDB().then(ok=>{
    hideSaving();
    toast(ok?`${stage} 세그먼트 저장 완료`:'저장 실패, 다시 시도하세요', ok?'ok':'err');
    render();
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

 async function init(){
  el('loginBtn').onclick = doLogin;
  el('logoutBtn').onclick = logout;
  ['loginId','loginPw'].forEach(id=> el(id).addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); }));
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
/* ============================================================================
   부트스트랩 실행 (반드시 파일 맨 끝, 단 한 번)
   ============================================================================ */
init();
/* ============================================================================
   ★ 신규생 안내 문자 생성 (4종: 신규등록 / Q앱 / 차량쌤 / 담임쌤)
   ============================================================================ */

/* Chess(체스) 레벨 → 교재 자동 매핑. 분원마다 문법책 다를 수 있어 수정 가능(입력칸).
   DSD1부터는 "문법책 + (레벨)포트폴리오" 형태. */
const CHESS_BOOKS = {
  DSA1:'Vocabulary Mentor Joy Start 1',
  DSA2:'Vocabulary Mentor Joy Start 2',
  DSB1:'Very Easy Writing 1',
  DSB2:'Grammar Mentor Joy Pre',
  DSC1:'Grammar Mentor Joy Early Start 1',
  DSC2:'Grammar Mentor Joy Early Start 2',
  DSD1:'Grammar Mentor Joy Start 1',
  DSD2:'Grammar Mentor Joy Start 2',
  LSA1:'Grammar Mentor Joy 1',
  LSA2:'Grammar Mentor Joy 2',
  LSB1:'Grammar Mentor Joy 3',
  LSB2:'Grammar Mentor Joy 4',
  LSC1:'Grammar Joy Plus 1',
  LSC2:'Grammar Joy Plus 2',
  LSD1:'제대로 영작문1',
  LSD2:'Grammar Joy Plus 3',
  MSA1:'제대로 영작문2',
  MSA2:'Grammar Joy Plus 4',
  MSB1:'제대로 영작문3',
  MSB2:'제대로 영작문4',
};
/* DSD1부터 포트폴리오 추가 — 레벨 순서상 DSD1 이상이면 포트폴리오 붙음 */
const CHESS_PORTFOLIO_FROM = ['DSD1','DSD2','LSA1','LSA2','LSB1','LSB2','LSC1','LSC2','LSD1','LSD2','MSA1','MSA2','MSB1','MSB2'];
/* 레벨코드로 체스 교재 문자열 생성. 매핑에 있으면 자동, 없으면 빈 문자열(=에이스 등은 수기). */
function chessBookFor(level){
  const lv = String(level||'').toUpperCase();
  const book = CHESS_BOOKS[lv];
  if(!book) return '';
  if(CHESS_PORTFOLIO_FROM.includes(lv)) return `${book} + ${lv} 포트폴리오`;
  return book;
}

/* 신규생 문자 상태 — 폼 입력값 + 문자카드 부가입력값을 모아두는 메모리(저장 안 함) */
const msgState = {
  tab:'enroll',          // enroll | qapp | bus | homeroom
  busRide:'round',       // round | go | come | none(담임용 X)
  bagGiven:false,        // 가방 받음 → 신규등록 문자에서 문구 삭제
  busOn:false,           // 차량 탑승(신규등록 문자용)
  bookStatus:'전달완료',  // 담임쌤 교재 상태 드롭다운
};

/* 현재 분원명에 "JLS" 붙인 제목용 분원명 (예: 서수원 → 서수원JLS) */
function branchTagName(){
  const b = getBranch(session.branchId);
  let nm = b ? b.name : '';
  nm = nm.replace(/분원$/,'').replace(/JLS/gi,'').trim();  // "서수원분원"/"서수원" → "서수원"
  return nm + 'JLS';
}
function branchPlainName(){
  const b = getBranch(session.branchId);
  return b ? b.name : '';
}

/* 신규생 추가 폼에서 현재 입력값 읽어오기 (실시간) */
function readNsForm(){
  // 등록 직후 잠긴 값이 있으면 그걸 우선 사용 (폼은 비워졌어도 문자엔 방금 등록한 학생 유지)
  if(msgState.locked) return msgState.locked;
  const csel = el('nsClassSelect');
  const pick = csel ? csel.value : '';
  let className='', classLbl='', teacher='', level='';
  const branchId = session.branchId, semId = state.semId;
  if(pick && pick!=='__new__'){
    const ref = activeRecordsOf(branchId, semId).find(r=>r.className===pick);
    className = pick;
    classLbl = (ref && ref.classLabel) || classLabel(pick) || pick;
    teacher = (ref && ref.teacher) || '';
    level = classLevel(pick);
  } else if(pick==='__new__'){
    className = (el('nsClass')?el('nsClass').value.trim():'') ;
    classLbl = classLabel(className) || className;
    teacher = (el('nsTeacher')?el('nsTeacher').value.trim():'');
    level = classLevel(className);
  }
  const semName = (db.semesters.find(s=>s.id===semId)||{}).name || '';
  // "2026년 여름학기" → "여름학기"만
  const semShort = semName.replace(/^\d+년\s*/,'');
  return {
    name: el('nsName')?el('nsName').value.trim():'',
    school: el('nsSchool')?el('nsSchool').value.trim():'',
    grade: el('nsGrade')?el('nsGrade').value.trim():'',
    date: el('nsDate')?el('nsDate').value:'',
    className, classLbl, teacher, level,
    semShort,
    isReturn: false,  // 수동 신규는 기본 신규생 (복귀 구분 필요시 추후)
  };
}
/* "2026-06-01" → "6/1(월)" 형태 */
function fmtKDate(iso){
  if(!iso) return '';
  const m = String(iso).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(!m) return iso;
  const d = new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3]));
  const wk = ['일','월','화','수','목','금','토'][d.getDay()];
  return `${parseInt(m[2])}/${parseInt(m[3])}(${wk})`;
}
/* 반 라벨에서 "월수금 1부" 부분만 (· 앞부분) */
function classTimeLabel(classLbl){
  if(!classLbl) return '';
  const parts = classLbl.split('·');
  return parts[0] ? parts[0].trim() : '';
}

/* ===== 문자 4종 본문 생성 ===== */
function buildEnrollMsg(f){
  const fee = el('msgFee')?el('msgFee').value.trim():'';
  const room = el('msgRoom')?el('msgRoom').value.trim():'';
  const timeRaw = el('msgClassTime')?el('msgClassTime').value.trim():'';
  const timeLine = [classTimeLabel(f.classLbl), timeRaw].filter(Boolean).join(' ');
 const bagLine = msgState.bagGiven ? '' : '\n▶ 가방 배부 : 수업 첫날 배부예정입니다.';
  const busLine = msgState.busOn ? '\n▶ 차량 안내 : 이번주 중으로 안내 예정입니다.' : '';
  return `[ ${branchTagName()} - ${f.semShort} 신규 등록 및 입학 안내 ]

안녕하세요? ${f.name||'ㅇㅇㅇ'}학생 학부모님.
${fmtKDate(f.date)||'(등원일)'}부터 시작하는 ${f.semShort} 등록 확정 및 준비사항 안내드립니다. 
# 수업정보 안내
▶ 수업시간 : ${timeLine}
▶ 레벨 : ${f.level||''}
▶ 수강료 : ${fee}
▶ 담임선생님: ${f.teacher||''}
▶ 강의실: ${room}

 
# 학기 시작 전 진행되어야 하는 사항
1. 정상어학원 사이트 가입
- 홈페이지에 학부모님이 먼저 가입해주세요.(www.gojls.com)
- 학부모님 가입 후 자녀추가하여 등록해 주세요. 학부모님 아이디로 로그인 하면 교재구매, 수강료 결제 가능합니다. 
- 학생 아이디는 과제시 필요합니다.
2. 교재 구매
- 정상어학원 홈페이지에서만 구매가능하며 집으로 배송됩니다.  
- 학부모 아이디로 로그인 후 '반 교재' 탭에서 배정된 교재 전부를 구매해 주시면 됩니다.

▶ 수강료 결제 
- 현장 결제 : 카드사 교육비 할인 카드는 현장결제시 적용됩니다.
- 온라인 결제 : www.gojls.com 정상어학원 사이트에서 학부모 아이디로 로그인 후 교육비 결제 가능 합니다. ${bagLine}${busLine}

▶ 담임선생님 인사 : 최대한 빠르게 연락드릴 예정입니다.
추가 문의사항은 학원으로 연락주시면 자세히 안내드리겠습니다. 
감사합니다.`;
}

function buildQappMsg(f){
  return `[ ${branchTagName()} - 학습관리Q(큐) 앱 설치 ]

안녕하세요? ${f.name||'(학생명)'}학생&학부모님. 
${branchPlainName()} 정상어학원입니다.

초등부 단어시험, 문법 시험,CHAT / 중등부 단어시험, 문법 시험 결과를 '학습관리Q(큐)' 앱을 통해 확인하실 수 있는 서비스가 제공됩니다

■ 학습관리Q(큐) 앱 소개
학습관리Q(큐)는 영어 학습의 핵심인 단어와 문법 학습 현황을 학부모님과 학생이 더욱 쉽게 확인할 수 있는 앱 서비스입니다.
* 학생 및 학부모님 모두 꼭 설치하셔서 사용해 주세요.

■ 설치 방법
1) 플레이스토어에 '학습관리 Q'검색
2) 다운로드 후 휴대폰 인증하여 로그인

■ 앱 기능
1) 학생의 학기별 단어 시험과 문법 시험 결과 확인 (개별/누적 현황)
2) 단어 시험 또는 문법 시험의 재시험 예약 및 알림 (미응시 포함)
3) 학기말평가, 영어능력평가, 수능모의고사, DT 결과 제공
정상어학원은 더 편리하고 세밀한 관리로 학생들의 영어 학습을 정상으로 이끌어갑니다. 
기타 문의사항은 학원으로 연락 부탁드립니다.
감사합니다.`;
}

function buildBusMsg(f){
  const stop = el('msgBusStop')?el('msgBusStop').value.trim():'';
  const phone = el('msgPhone')?el('msgPhone').value.trim():'';
  const timeRaw = el('msgClassTime')?el('msgClassTime').value.trim():'';
  const timeLine = [classTimeLabel(f.classLbl), timeRaw].filter(Boolean).join(' ');
  const schoolGrade = [f.school, f.grade].filter(Boolean).join(' ');
  const who = f.isReturn ? '복귀생' : '신규생';
  let note = `${fmtKDate(f.date)||'(등원일)'}부터 등원하는 ${who}입니다.`;
  if(msgState.busRide==='go') note += ' 등원만 탑승합니다.';
  else if(msgState.busRide==='come') note += ' 하원만 탑승합니다.';
  return `※ 차량 전달 
${f.name||'(학생명)'}(${schoolGrade}) 
▶탑승장소: ${stop}
▶시간 : ${timeLine}
▶학부모님 : ${phone}
▶등원일 : ${fmtKDate(f.date)}
▶특이사항: ${note}`;
}

function buildHomeroomMsg(f){
  const stop = el('msgBusStop')?el('msgBusStop').value.trim():'';
  const bookInput = el('msgBook')?el('msgBook').value.trim():'';
  const bookStatusSel = el('msgBookStatus')?el('msgBookStatus').value:'전달완료';
  const bookStatusCustom = el('msgBookStatusCustom')?el('msgBookStatusCustom').value.trim():'';
  const status = (bookStatusSel==='__custom__') ? bookStatusCustom : bookStatusSel;
  const bookLine = bookInput ? `${bookInput} ${status}` : status;
  const schoolGrade = [f.school, f.grade].filter(Boolean).join(' ');
  const who = f.isReturn ? '복귀생' : '신규생';
  // 차량 줄
  let busLine;
  if(msgState.busRide==='none') busLine = 'X';
  else {
    const rideTxt = {round:'왕복', go:'등원만', come:'하원만'}[msgState.busRide]||'왕복';
    busLine = stop ? `${rideTxt} / ${stop}` : rideTxt;
  }
  const lvl = f.level ? `${classTimeLabel(f.classLbl)} ${f.level}`.trim() : (f.classLbl||'');
  return `[${who}]
1.${f.name||'(학생명)'}(${schoolGrade})
2.${lvl}
3.등원일:${fmtKDate(f.date)}
4.교재구매:구매예정
5.차량:${busLine}
6.HC:전화 부탁드립니다.
7.가방:${msgState.bagGiven?'O':'X'}
8.문법책/지내수: ${bookLine}
${f.teacher||'ㅇㅇㅇ'}선생님 신규 등록하였습니다. 전화 부탁드립니다.감사합니다.`;
}

/* 현재 탭의 문자 본문 생성 */
function buildCurrentMsg(){
  const f = msgState.locked ? msgState.locked : readNsForm();
  if(msgState.tab==='enroll') return buildEnrollMsg(f);
  if(msgState.tab==='qapp') return buildQappMsg(f);
  if(msgState.tab==='bus') return buildBusMsg(f);
  if(msgState.tab==='homeroom') return buildHomeroomMsg(f);
  return '';
}

/* 탭별 부가입력 필드 HTML */
function msgExtraFields(){
  const tab = msgState.tab;
  const lvl = classLevel((el('nsClassSelect')&&el('nsClassSelect').value)||'') || '';
  if(tab==='enroll'){
    return `
      <div class="form-row">
        <div class="field"><label>수업시간 (반명 뒤 시간)</label><input id="msgClassTime" placeholder="예: 14:30~16:10" oninput="refreshMsg()"></div>
        <div class="field"><label>수강료</label><input id="msgFee" placeholder="예: 250,000원" oninput="refreshMsg()"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>강의실</label><input id="msgRoom" placeholder="예: 201호" oninput="refreshMsg()"></div>
        <div class="field"></div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 10px">
        <label class="msg-chk"><input type="checkbox" id="msgBag" onchange="msgState.bagGiven=this.checked;refreshMsg()"> 가방 받음 (체크 시 문구 삭제)</label>
        <label class="msg-chk"><input type="checkbox" id="msgBusOn" onchange="msgState.busOn=this.checked;refreshMsg()"> 차량 탑승 (체크 시 안내 문구 추가)</label>
      </div>`;
  }
  if(tab==='qapp'){
    return `<div class="msg-note">학생명·분원명만 자동으로 들어갑니다. 추가 입력 없음.</div>`;
  }
  if(tab==='bus'){
    return `
      <div class="form-row">
        <div class="field"><label>탑승장소</label><input id="msgBusStop" placeholder="예: 가온초 정문" oninput="refreshMsg()"></div>
        <div class="field"><label>학부모님 전화번호</label><input id="msgPhone" placeholder="예: 01012345678" oninput="refreshMsg()"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>수업시간</label><input id="msgClassTime" placeholder="예: 14:30~16:10" oninput="refreshMsg()"></div>
        <div class="field full" style="align-self:flex-end">
          <label>탑승 구분</label>
          <div class="seg-toggle">
            ${['round','go','come'].map(k=>{
              const lbl={round:'왕복',go:'등원만',come:'하원만'}[k];
              return `<button type="button" class="seg-btn ${msgState.busRide===k?'on':''}" onclick="setBusRide('${k}')">${lbl}</button>`;
            }).join('')}
          </div>
        </div>
      </div>`;
  }
  if(tab==='homeroom'){
    const autoBook = chessBookFor(lvl);
    return `
      <div class="form-row">
        <div class="field full"><label>문법책 (체스는 레벨 선택 시 자동 · 에이스는 직접 입력 · 분원 다르면 수정)</label>
          <input id="msgBook" placeholder="문법 교재명" value="${esc(autoBook)}" oninput="refreshMsg()"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>교재 전달 상태</label>
          <select id="msgBookStatus" onchange="onBookStatusChange()">
            <option value="전달완료">전달완료</option>
            <option value="수업 첫날 배부예정">수업 첫날 배부예정</option>
            <option value="OT날 배부예정">OT날 배부예정</option>
            <option value="담임선생님께 배부예정">담임선생님께 배부예정</option>
            <option value="__custom__">직접 입력…</option>
          </select></div>
        <div class="field"><label>직접 입력</label><input id="msgBookStatusCustom" placeholder="상태 직접 입력" oninput="refreshMsg()" disabled></div>
      </div>
      <div class="form-row">
        <div class="field"><label>탑승장소 (차량 탈 때만)</label><input id="msgBusStop" placeholder="예: 가온초 정문" oninput="refreshMsg()"></div>
        <div class="field full" style="align-self:flex-end">
          <label>차량</label>
          <div class="seg-toggle">
            ${['round','go','come','none'].map(k=>{
              const lbl={round:'왕복',go:'등원만',come:'하원만',none:'안 탐(X)'}[k];
              return `<button type="button" class="seg-btn ${msgState.busRide===k?'on':''}" onclick="setBusRide('${k}')">${lbl}</button>`;
            }).join('')}
          </div>
        </div>
      </div>
      <div style="margin:4px 0 10px">
        <label class="msg-chk"><input type="checkbox" id="msgBagHr" ${msgState.bagGiven?'checked':''} onchange="msgState.bagGiven=this.checked;refreshMsg()"> 가방 받음 (O / 미체크 시 X)</label>
      </div>`;
  }
  return '';
}
function onBookStatusChange(){
  const sel = el('msgBookStatus');
  const custom = el('msgBookStatusCustom');
  if(sel && custom){
    custom.disabled = (sel.value!=='__custom__');
    if(sel.value!=='__custom__') custom.value='';
  }
  refreshMsg();
}
function setBusRide(k){ msgState.busRide=k; renderMsgCard(); }

/* 문자 카드 전체 렌더 (탭 + 부가입력 + 미리보기) */
function renderMsgCard(){
  const box = el('msgCardBody');
  if(!box) return;
  const tabs = [
    {k:'enroll', l:'신규등록'},
    {k:'qapp', l:'Q앱 설치'},
    {k:'bus', l:'차량쌤'},
    {k:'homeroom', l:'담임쌤'},
  ];
  box.innerHTML = `
    <div class="msg-tabs">
      ${tabs.map(t=>`<button type="button" class="msg-tab ${msgState.tab===t.k?'on':''}" onclick="setMsgTab('${t.k}')">${t.l}</button>`).join('')}
    </div>
    <div class="msg-extra">${msgExtraFields()}</div>
    <div class="msg-preview-wrap">
      <div class="msg-preview-head">
        <span>문자 미리보기</span>
        <button type="button" class="btn sm primary" onclick="copyMsg()">📋 복사</button>
      </div>
      <textarea id="msgPreview" class="msg-preview" rows="16" readonly></textarea>
    </div>
<div class="msg-hint">왼쪽 신규생 정보를 입력하면 실시간으로 반영됩니다. 문법 교재가 분원과 다르면 직접 수정하세요.</div>`;
// DOM 다 그려진 뒤 미리보기 채움
  const pv = el('msgPreview');
  if(msgState.locked){
    // 방금 등록한 학생 문자를 유지 (locked 값으로 미리보기 표시)
    if(pv) pv.value = buildCurrentMsg();
  } else {
    refreshMsg();
  }
}
function setMsgTab(k){ msgState.tab=k; renderMsgCard(); }
/* 미리보기만 갱신 (부가입력 칸 포커스 유지 — 전체 리렌더 안 함) */
function refreshMsg(){
  // 폼에 새로 입력하기 시작하면 잠금 해제 (다음 학생 문자로 전환)
  msgState.locked = null;
  const pv = el('msgPreview');
  if(pv) pv.value = buildCurrentMsg();
}
function copyMsg(){
  const txt = buildCurrentMsg();
  navigator.clipboard.writeText(txt).then(
    ()=> toast('문자가 복사되었습니다','ok'),
    ()=>{
      // 폴백
      const ta=el('msgPreview'); ta.removeAttribute('readonly'); ta.select();
      try{ document.execCommand('copy'); toast('문자가 복사되었습니다','ok'); }
      catch(e){ toast('복사 실패 — 직접 선택해 복사하세요','err'); }
      ta.setAttribute('readonly','');
    }
  );
}
/* 반 검색 결과 렌더 — 타이핑 즉시 필터링 (레벨·반명·담임 다 검색) */
function renderNsClassResults(){
  const search = el('nsClassSearch');
  const box = el('nsClassResults');
  const sel = el('nsClassSelect');
  if(!search || !box || !sel) return;
  const q = search.value.trim().toLowerCase();
  // 숨은 select의 option들을 후보로 사용 (className=value, 라벨=textContent)
  const opts = [];
  for(const opt of sel.options){
    if(opt.value==='' || opt.value==='__new__') continue;
    opts.push({ className:opt.value, label:opt.textContent.trim() });
  }
  // 검색어로 필터 (라벨에 레벨·반명·담임 다 들어있어서 한 번에 걸림)
  const filtered = q ? opts.filter(o=> o.label.toLowerCase().includes(q)) : opts;
  let rows = filtered.slice(0,40).map(o=>
    `<div class="wd-item" onclick="pickNsClass('${esc(o.className).replace(/'/g,"\\'")}')">
      <div class="wd-main"><span class="wd-name">${esc(o.label)}</span></div>
    </div>`).join('');
  // 맨 아래 '새 반 직접 입력' 항상 노출
  rows += `<div class="wd-item" onclick="pickNsClass('__new__')" style="border-top:1px solid var(--line)">
      <div class="wd-main"><span class="wd-name" style="color:var(--brand)">＋ 새 반 직접 입력</span></div>
    </div>`;
  box.innerHTML = filtered.length===0 && q
    ? `<div class="wd-empty">검색 결과 없음</div>` + rows
    : rows;
  box.style.display = 'block';
}
/* 검색 결과에서 반 선택 → 숨은 select 값 맞추고 확정 표시 */
function pickNsClass(className){
  const sel = el('nsClassSelect');
  const search = el('nsClassSearch');
  const box = el('nsClassResults');
  const picked = el('nsClassPicked');
  if(!sel) return;
  sel.value = className;
  if(box) box.style.display = 'none';
  if(className==='__new__'){
    if(search) search.value = '';
    el('nsNewClassRow').style.display = 'flex';
    if(picked) picked.style.display = 'none';
  } else {
    el('nsNewClassRow').style.display = 'none';
    // 고른 반 라벨 찾아서 확정 표시
    let label = '';
    for(const opt of sel.options){ if(opt.value===className){ label=opt.textContent.trim(); break; } }
    if(search) search.value = '';
    if(picked){
      picked.style.display = 'block';
      picked.innerHTML = `<div class="wd-picked-card">
        <div><div class="wd-picked-name">선택된 반: <b>${esc(label)}</b></div></div>
        <button class="btn sm" onclick="clearNsClass()">변경</button>
      </div>`;
    }
  }
  renderMsgCard();
}
/* 반 선택 취소 → 다시 검색 가능하게 */
function clearNsClass(){
  const sel = el('nsClassSelect');
  if(sel) sel.value = '';
  const picked = el('nsClassPicked');
  if(picked){ picked.style.display='none'; picked.innerHTML=''; }
  el('nsNewClassRow').style.display = 'none';
  const search = el('nsClassSearch');
  if(search){ search.value=''; search.focus(); }
  renderMsgCard();
}
let startState = {
  active: [],
  logRows: [],
  viewDate: null,
  channel: null,
  ticker: null,
  muted: false,
};

let startMode = 'outing';
/* ---- 메인 렌더 ---- */
async function renderStart(){
  crumbs([{label:'STaRT 외출·시험 관리'}]);
  if(!startState.viewDate) startState.viewDate = startTodayStr();
 
  el('content').innerHTML = `
    <div class="page-head" style="display:flex;align-items:flex-end;justify-content:space-between">
      <div>
        <h2>STaRT 외출·시험 관리</h2>
        <div class="sub">${esc(getBranch(session.branchId)?.name||'')} · 시험 10분 · 외출 15분 · 실시간 공유</div>
      </div>
      <button class="btn sm" id="stLogBtn">📋 기록 보기</button>
    </div>
 
    <div class="panel" style="margin-bottom:16px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div class="st-modetog" id="stModeTog">
          <button type="button" data-mode="exam" class="st-mode-btn"><i class="ti ti-pencil"></i> 시험</button>
          <button type="button" data-mode="outing" class="st-mode-btn active"><i class="ti ti-walk"></i> 외출</button>
        </div>
        <select id="stMin" onchange="startOnMinChange()" class="st-inp" style="width:110px">
          <option value="__auto__" selected>기본 시간</option>
          <option value="10">10분</option><option value="15">15분</option>
          <option value="20">20분</option><option value="30">30분</option>
          <option value="__custom__">직접 입력</option>
        </select>
        <input id="stMinCustom" type="number" min="1" max="180" placeholder="분" class="st-inp" style="width:80px;display:none">
        <div style="position:relative;flex:1;min-width:240px">
          <input id="stInput" placeholder="이름 또는 회원코드 입력 후 Enter" autocomplete="off" class="st-inp" style="width:100%">
          <div id="stAc" class="wd-results" style="display:none;position:absolute;top:44px;left:0;right:0;z-index:50;max-height:300px;overflow-y:auto"></div>
        </div>
        <button class="btn primary" id="stAddBtn">등록</button>
        <button class="btn" id="stMuteBtn" title="소리">🔊</button>
        <button class="btn" id="stPermBtn">알림 허용</button>
      </div>
      <div id="stPermHint" style="margin-top:8px;font-size:12px;color:var(--warn);display:none">
        다른 창을 봐도 알림을 받으려면 <b>알림 허용</b>을 눌러주세요. (컴퓨터마다 한 번씩)
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--ink-3)">
        키보드 — 이름 입력 후 <b>↑↓</b> 학생 선택 · <b>Enter</b> 등록 · <b>←→</b> 시험/외출 전환
      </div>
    </div>
 
    <div class="st-columns">
      <div class="st-col st-col-exam">
        <div class="st-col-head"><i class="ti ti-pencil"></i><span>시험</span><span id="stExamCount" class="st-col-cnt">0</span></div>
        <div id="stExamOver" class="st-list st-over-zone"></div>
        <div id="stExamNormal" class="st-list"></div>
        <div id="stExamEmpty" class="st-empty">진행 중인 시험이 없습니다</div>
      </div>
      <div class="st-col st-col-outing">
        <div class="st-col-head"><i class="ti ti-walk"></i><span>외출</span><span id="stOutCount" class="st-col-cnt">0</span></div>
        <div id="stOutOver" class="st-list st-over-zone"></div>
        <div id="stOutNormal" class="st-list"></div>
        <div id="stOutEmpty" class="st-empty">외출 중인 학생이 없습니다</div>
      </div>
    </div>`;
 
  startInjectStyles();
  startBindUI();
  await startLoadSessions(startState.viewDate);
  startSubscribe();
  startStartTicker();
  startRefreshPermHint();
  el('stInput').focus();
}
 
/* ---- 카드(줄) 렌더 ---- */
function startRenderCards(){
  const zones={ examOver:el('stExamOver'), examNormal:el('stExamNormal'),
                outOver:el('stOutOver'), outNormal:el('stOutNormal') };
  if(!zones.examNormal) return;
  const now=new Date();
  const b={examOver:[],examNormal:[],outOver:[],outNormal:[]};
  startState.active.forEach(a=>{
    const elapsed=Math.floor((now-new Date(a.leftAt))/1000);
    const over=elapsed>=a.limitSec;
    const key=(a.kind==='exam'?'exam':'out')+(over?'Over':'Normal');
    b[key].push(a);
  });
  Object.keys(zones).forEach(k=> zones[k].innerHTML=b[k].map(startRowHTML).join(''));
  const exam=b.examOver.length+b.examNormal.length;
  const out=b.outOver.length+b.outNormal.length;
  el('stExamCount').textContent=exam;
  el('stOutCount').textContent=out;
  el('stExamEmpty').style.display=exam?'none':'block';
  el('stOutEmpty').style.display=out?'none':'block';
  startTick();
}
function startRowHTML(a){
  const meta=[a.cls,a.teacher].filter(Boolean).join(' · ');
  return `<div class="st-row" data-id="${a.id}">
    <div class="st-row-info">
      <div class="st-row-name">${esc(a.name)}<span class="st-row-badge">초과</span></div>
      <div class="st-row-meta">${esc(meta||'—')} · 시작 ${startHM(a.leftAt)}</div>
    </div>
    <div class="st-row-timer">00:00</div>
    <div class="st-row-acts">
     <button class="st-mini ret" onclick="startReturn('${a.id}')" title="${a.kind==='exam'?'시험완료':'복귀'}"><i class="ti ti-check"></i></button>
      <button class="st-mini can" onclick="startCancel('${a.id}')" title="취소"><i class="ti ti-x"></i></button>
    </div>
  </div>`;
}
function startStartTicker(){ if(startState.ticker) clearInterval(startState.ticker); startState.ticker=setInterval(startTick,1000); }
function startTick(){
  const now=new Date(); let reflow=false;
  startState.active.forEach(a=>{
    const elapsed=Math.floor((now-new Date(a.leftAt))/1000);
    const remain=a.limitSec-elapsed;
    const isOver=remain<=0;
    if(a._over!==isOver){ a._over=isOver; reflow=true; }
    const row=document.querySelector(`.st-row[data-id="${a.id}"]`);
    if(!row) return;
    const t=row.querySelector('.st-row-timer');
    if(remain>0){
      t.textContent=startDur(remain);
      t.style.color=remain<=180?'var(--warn)':'var(--pos)';
      row.classList.remove('over');
    } else {
      t.textContent='+'+startDur(elapsed-a.limitSec);
      t.style.color='#fff';
      row.classList.add('over');
      if(!a.alarmed && !a.alarmCleared){ a.alarmed=true; startFireAlarm(a); }
    }
  });
  if(reflow) startRenderCards();
}
 
/* ---- 기록 팝업 ---- */
function startOpenLogModal(){
  const rows=startState.logRows;
  const body=rows.length? rows.map(r=>{
    const el2=r.returnedAt?Math.round((new Date(r.returnedAt)-new Date(r.leftAt))/1000):null;
    const over=el2!=null&&el2>r.limitSec;
    const k=r.kind==='exam'?'시험':'외출';
    return `<tr><td>${k}</td><td>${esc(r.name)}</td><td>${esc(r.cls||'—')}</td><td>${esc(r.teacher||'—')}</td>
      <td class="num">${startHM(r.leftAt)}</td><td class="num">${r.returnedAt?startHM(r.returnedAt):'—'}</td>
      <td class="num">${el2!=null?startDur(el2):'—'}</td>
      <td style="font-weight:700;color:${over?'var(--neg)':'var(--pos)'}">${over?'초과':'정상'}</td>
      <td class="cc"><button class="btn sm" style="color:var(--neg)" onclick="startDeleteLog('${r.id}')">삭제</button></td></tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--ink-3)">기록이 없습니다</td></tr>`;
 
  openModal(`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h3 style="font-size:16px;font-weight:800">기록 <span style="color:var(--ink-3);font-weight:500">${rows.length}명</span></h3>
      <div style="display:flex;gap:10px;align-items:center">
        <input type="date" id="stDate" value="${startState.viewDate}" class="st-inp" style="height:34px">
        <button class="btn sm" id="stCsvBtn">CSV</button>
      </div>
    </div>
    <div class="table-wrap"><div class="table-scroll" style="max-height:60vh">
      <table class="grid">
        <thead><tr><th>구분</th><th>이름</th><th>반</th><th>담임</th><th>시작</th><th>복귀</th><th>소요</th><th>결과</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div></div>`, {wide:true});
 
  const d=el('stDate'); if(d) d.onchange=()=>{ startState.viewDate=d.value; startLoadSessions(startState.viewDate).then(()=>startOpenLogModal()); };
  const c=el('stCsvBtn'); if(c) c.onclick=startDownloadCSV;
}
 
/* ---- 이벤트 바인딩 ---- */
function startBindUI(){
  const input=el('stInput');
  input.addEventListener('input', startOnInput);
  input.addEventListener('keydown', startOnKeydown);
  el('stAddBtn').onclick=()=>{
    const m=startFindStudents(input.value);
    if(m.length===1) startAdd(m[0]);
    else if(m.length>1){ startOnInput(); toast('여러 명 검색됨 — ↑↓로 선택'); }
    else toast('일치하는 학생이 없습니다','err');
  };
  el('stMuteBtn').onclick=()=>{ startState.muted=!startState.muted; el('stMuteBtn').textContent=startState.muted?'🔇':'🔊'; };
  el('stPermBtn').onclick=startAskPerm;
  el('stLogBtn').onclick=startOpenLogModal;
  el('stModeTog').querySelectorAll('.st-mode-btn').forEach(btn=> btn.onclick=()=>startSetMode(btn.dataset.mode));
  document.addEventListener('click', startDocClick);
}
function startSetMode(mode){
  startMode=mode;
  const tog=el('stModeTog'); if(!tog) return;
  tog.querySelectorAll('.st-mode-btn').forEach(b=> b.classList.toggle('active', b.dataset.mode===mode));
}
function startDocClick(e){
  const ac=el('stAc'), input=el('stInput'); if(!ac||!input) return;
  if(e.target!==input && !ac.contains(e.target)) ac.style.display='none';
}
function startOnInput(){
  const q=el('stInput').value, box=el('stAc');
  if(!q.trim()){ box.style.display='none'; startAcList=[]; startAcSel=-1; return; }
  startAcList=startFindStudents(q); startAcSel=-1;
  if(!startAcList.length){ box.innerHTML=`<div class="wd-empty">일치하는 학생이 없습니다</div>`; box.style.display='block'; return; }
  box.innerHTML=startAcList.map((s,i)=>{
    const info=startStudentInfo(s);
    const meta=[info.cls,info.teacher,info.code].filter(Boolean).join(' · ');
    return `<div class="wd-item" data-i="${i}"><div class="wd-main"><span class="wd-name">${esc(s.name)}</span></div><div class="wd-meta">${esc(meta)}</div></div>`;
  }).join('');
  box.querySelectorAll('.wd-item').forEach(it=> it.onclick=()=> startAdd(startAcList[parseInt(it.dataset.i,10)]));
  box.style.display='block';
}
function startOnKeydown(e){
  const box=el('stAc');
  const open = box.style.display==='block' && startAcList.length>0;
  if(e.key==='ArrowDown'){ if(open){ e.preventDefault(); startAcSel=Math.min(startAcSel+1,startAcList.length-1); startUpdateAcSel(); } return; }
  if(e.key==='ArrowUp'){ if(open){ e.preventDefault(); startAcSel=Math.max(startAcSel-1,0); startUpdateAcSel(); } return; }
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
    // 입력창이 비어있을 때만 시험/외출 전환 (글자 있으면 커서 이동 방해 안 함)
    if(!el('stInput').value){ e.preventDefault(); startSetMode(startMode==='exam'?'outing':'exam'); }
    return;
  }
  if(e.key==='Enter'){
    e.preventDefault();
    if(open && startAcSel>=0){ startAdd(startAcList[startAcSel]); return; }
    const m=startFindStudents(el('stInput').value);
    if(m.length===1) startAdd(m[0]);
    else if(m.length>1) startOnInput();
    else toast('일치하는 학생이 없습니다','err');
    return;
  }
  if(e.key==='Escape'){ box.style.display='none'; }
}
function startUpdateAcSel(){
  el('stAc').querySelectorAll('.wd-item').forEach((it,i)=>{
    it.classList.toggle('sel', i===startAcSel);
    if(i===startAcSel) it.scrollIntoView({block:'nearest'});
  });
}
 
/* ---- 스타일 ---- */
function startInjectStyles(){
  const old=document.getElementById('stV3Style'); if(old) old.remove();
  if(document.getElementById('stV4Style')) return;
  const st=document.createElement('style'); st.id='stV4Style';
  st.textContent=`
    .st-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .st-col{border-radius:14px;padding:12px}
    .st-col-exam{background:#F4F8FD;border:1px solid #D3E4F5}
    .st-col-outing{background:#F3FAF6;border:1px solid #C9E9DC}
    .st-col-head{display:flex;align-items:center;gap:8px;padding:2px 4px 12px;margin-bottom:12px;font-size:16px;font-weight:800;border-bottom:1px solid rgba(0,0,0,.06)}
    .st-col-exam .st-col-head{color:#0C447C}.st-col-exam .st-col-head i{color:#185FA5}
    .st-col-outing .st-col-head{color:#085041}.st-col-outing .st-col-head i{color:#0F6E56}
    .st-col-cnt{margin-left:auto;font-size:13px;font-weight:700;border-radius:999px;padding:2px 10px}
    .st-col-exam .st-col-cnt{background:#E6F1FB;color:#185FA5}
    .st-col-outing .st-col-cnt{background:#E1F5EE;color:#0F6E56}
    .st-list{display:flex;flex-direction:column;gap:8px}
    .st-over-zone{margin-bottom:0}
    .st-over-zone:not(:empty){margin-bottom:8px}
    .st-empty{text-align:center;color:var(--ink-3);font-size:13px;padding:24px 0}
    .st-row{display:flex;align-items:center;gap:12px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:9px 12px}
    .st-row-info{flex:1;min-width:0}
    .st-row-name{font-size:16px;font-weight:700;color:var(--ink-1);display:flex;align-items:center;gap:6px}
    .st-row-badge{display:none;font-size:11px;font-weight:800;color:#fff;background:var(--neg);border-radius:5px;padding:1px 7px}
    .st-row-meta{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .st-row-timer{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--pos);letter-spacing:-.5px;min-width:64px;text-align:right}
    .st-row-acts{display:flex;gap:6px}
    .st-mini{height:32px;padding:0 12px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;white-space:nowrap}
    .st-mini.ret{background:var(--brand);color:#fff}
    .st-mini.can{background:var(--surface-1);color:var(--ink-3);border:1px solid var(--line)}
    .st-row.over{background:#FCEEEE;border-color:var(--neg);animation:stFlash .9s infinite}
    .st-row.over .st-row-badge{display:inline-block}
    @keyframes stFlash{0%,100%{background:#FCEEEE}50%{background:#f7dede}}
    .st-inp{height:40px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);font-size:15px}
    .st-modetog{display:inline-flex;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden;height:40px}
    .st-mode-btn{border:none;background:transparent;padding:0 16px;font-size:15px;font-weight:700;color:var(--ink-3);cursor:pointer;display:flex;align-items:center;gap:6px}
    .st-mode-btn.active{background:var(--brand);color:#fff}
    #stOverlay{position:fixed;inset:0;z-index:9999;background:#1a1416;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;animation:stOvIn .25s ease-out}
    @keyframes stOvIn{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
    #stOverlay::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:#c0392b}
    .st-ov-tag{display:inline-flex;align-items:center;gap:8px;background:rgba(192,57,43,.15);border:1px solid rgba(192,57,43,.5);border-radius:999px;padding:7px 18px;margin-bottom:28px;font-size:14px;font-weight:500;color:#e8a0a0;letter-spacing:2px}
    .st-ov-names{display:flex;flex-direction:column;gap:14px;margin-bottom:28px}
    .st-ov-row{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap}
    .st-ov-name{font-size:52px;font-weight:500;color:#fff;line-height:1;letter-spacing:-1px}
    .st-ov-over{font-size:15px;font-weight:500;color:#1a1416;background:#e74c3c;border-radius:8px;padding:5px 12px}
    .st-ov-sub{font-size:16px;color:rgba(255,255,255,.6);margin-bottom:32px}
    .st-ov-btn{background:#fff;color:#1a1416;border:none;border-radius:12px;font-size:17px;font-weight:500;padding:14px 48px;cursor:pointer}
    .st-ov-btn:hover{opacity:.9}
    @media(max-width:900px){.st-columns{grid-template-columns:1fr}}`;
  document.head.appendChild(st);
}
/* ============================================================================
   STaRT 헬퍼 함수 (복구) — app.js 아무 데나(함수 밖) 붙여넣기
   ============================================================================ */

/* 반 원본(class_name)에서 레벨코드만: "[PA2]SU3/MWF/..." -> "PA2" */
function startLevelOf(raw){
  const m = String(raw||'').match(/^\s*\[([A-Za-z]+[0-9]*)/);
  return m ? m[1] : '';
}
/* class_label의 · 앞부분 (예: "월수금 3부") */
function startTimeLabelOf(label){
  if(!label) return '';
  const p = String(label).split('·');
  return p[0] ? p[0].trim() : '';
}
/* 현재 학기 이 분원의 학생 → {level, timeLabel, teacher} 매핑 */
function startRecMap(){
  const branchId = session.branchId, semId = state.semId;
  const map = new Map();
  db.semesterRecords
    .filter(r=>r.branchId===branchId && r.semesterId===semId)
    .forEach(r=>{
      const prev = map.get(r.studentId);
      if(prev && prev.status==='active' && r.status!=='active') return;
      map.set(r.studentId, {
        level: startLevelOf(r.className),
        timeLabel: startTimeLabelOf(r.classLabel),
        teacher: r.teacher||'',
        status: r.status,
      });
    });
  return map;
}
/* 학생 검색 (이름/회원코드) — 이 분원 명단 안에서만 */
function startFindStudents(query){
  const q = query.trim().toLowerCase();
  if(!q) return [];
  const branchId = session.branchId, semId = state.semId;
  const myStudentIds = new Set(
    db.semesterRecords.filter(r=>r.branchId===branchId && r.semesterId===semId).map(r=>r.studentId)
  );
  return db.students
    .filter(s=> myStudentIds.has(s.id) &&
      ((s.name||'').toLowerCase().includes(q) || (s.code||'').toLowerCase().includes(q)))
    .slice(0,8);
}
function startStudentInfo(stu){
  const rec = startRecMap().get(stu.id) || {};
  const cls = [rec.timeLabel, rec.level].filter(Boolean).join(' ');
  return { id:stu.id, code:stu.code, name:stu.name, cls, teacher:rec.teacher||'' };
}

/* ---- 시간 헬퍼 ---- */
function startPad(n){ return String(n).padStart(2,'0'); }
function startTodayStr(){ const d=new Date(); return `${d.getFullYear()}-${startPad(d.getMonth()+1)}-${startPad(d.getDate())}`; }
function startHM(iso){ const d=new Date(iso); return `${startPad(d.getHours())}:${startPad(d.getMinutes())}`; }
function startDur(sec){ const neg=sec<0; sec=Math.abs(sec); return (neg?'-':'')+startPad(Math.floor(sec/60))+':'+startPad(sec%60); }
 function startAskPerm(){
  if(!('Notification' in window)){ toast('이 브라우저는 알림을 지원하지 않습니다','err'); return; }
  Notification.requestPermission().then(p=>{
    startRefreshPermHint();
    if(p==='granted') toast('알림이 허용되었습니다','ok');
    else toast('알림이 차단됨 — 주소창 자물쇠 아이콘에서 허용하세요','err');
  });
}
function startRefreshPermHint(){
  const hint=el('stPermHint'); if(!hint) return;
  hint.style.display = (('Notification' in window)&&Notification.permission==='default')?'block':'none';
} 
/* ---- 데이터 로드 ---- */
async function startLoadSessions(dateStr){
  if(!sb){ try{ initSupabase(); }catch(e){ console.error(e); return; } }
  const { data, error } = await sb.from('start_sessions').select('*')
    .eq('branch_id', session.branchId).eq('date', dateStr)
    .order('left_at', { ascending:false });
  if(error){ console.error(error); toast('기록 로드 실패','err'); return; }
  const rows=(data||[]).map(startFromRow);
  startState.active = rows.filter(r=>r.status==='out');
  startState.logRows = rows.filter(r=>r.status==='returned');
  startRenderCards(); startSyncOverlay();
}
function startFromRow(r){
  return { id:r.id, studentId:r.student_id, name:r.name, cls:r.cls, teacher:r.teacher,
    leftAt:r.left_at, returnedAt:r.returned_at, limitSec:r.limit_sec, status:r.status,
    date:r.date, kind:r.kind||'outing', alarmCleared:!!r.alarm_cleared, alarmed:false, _over:false };
}
 
/* ---- 기본 시간(모드별) ---- */
function startLimitSec(){
  const sel=el('stMin');
  if(!sel) return startMode==='exam'?600:900;
  if(sel.value==='__auto__') return startMode==='exam'?600:900;
  if(sel.value==='__custom__'){ const m=parseInt(el('stMinCustom').value,10); return (m>0?m:(startMode==='exam'?10:15))*60; }
  return parseInt(sel.value,10)*60;
}
function startOnMinChange(){
  const sel=el('stMin'), cust=el('stMinCustom');
  cust.style.display=(sel.value==='__custom__')?'inline-block':'none';
  if(sel.value==='__custom__') cust.focus();
}
 
/* ---- 등록 ---- */
async function startAdd(stu){
  const info=startStudentInfo(stu);
  if(startState.active.some(a=>a.studentId===stu.id)){ toast(`${info.name} 학생은 이미 진행 중입니다`,'err'); return; }
  const limitSec=startLimitSec();
  const row={ branch_id:session.branchId, date:startTodayStr(), student_id:stu.id,
    name:info.name, cls:info.cls, teacher:info.teacher, left_at:new Date().toISOString(),
    returned_at:null, limit_sec:limitSec, status:'out', kind:startMode, alarm_cleared:false, by_user:session.username };
  const { data, error } = await sb.from('start_sessions').insert(row).select().single();
  if(error){ console.error(error); toast('등록 실패 — 다시 시도하세요','err'); return; }
  if(!startState.active.some(a=>a.id===data.id)){ startState.active.unshift(startFromRow(data)); startRenderCards(); }
  el('stInput').value=''; el('stAc').style.display='none'; el('stInput').focus();
  startUnlockAudio();
}
async function startReturn(id){
  const a=startState.active.find(x=>x.id===id); if(!a) return;
  const ret=new Date().toISOString();
  const { error } = await sb.from('start_sessions').update({ status:'returned', returned_at:ret }).eq('id', id);
  if(error){ console.error(error); toast('처리 실패','err'); return; }
  a.returnedAt=ret; a.status='returned';
  startState.active=startState.active.filter(x=>x.id!==id);
  startState.logRows.unshift(a);
  startRenderCards(); startSyncOverlay();
}
async function startCancel(id){
  const { error } = await sb.from('start_sessions').delete().eq('id', id);
  if(error){ console.error(error); toast('취소 실패','err'); return; }
  startState.active=startState.active.filter(x=>x.id!==id);
  startRenderCards(); startSyncOverlay();
}
async function startDeleteLog(id){
  const r=startState.logRows.find(x=>x.id===id); if(!r) return;
  if(!confirm(`${r.name} 학생의 이 기록을 삭제할까요?`)) return;
  const { error } = await sb.from('start_sessions').delete().eq('id', id);
  if(error){ console.error(error); toast('삭제 실패','err'); return; }
  startState.logRows=startState.logRows.filter(x=>x.id!==id);
  toast('기록 삭제됨','ok');
  if(document.getElementById('modalOverlay') && document.getElementById('modalOverlay').style.display!=='none') startOpenLogModal();
}
 
/* ---- 경고 공유: 한 명이 확인하면 모두 꺼짐 ---- */
async function startClearAlarm(){
  const now=new Date();
  const overIds=startState.active.filter(a=>{ const e=Math.floor((now-new Date(a.leftAt))/1000); return e>=a.limitSec; }).map(a=>a.id);
  startCloseOverlay();
  if(!overIds.length) return;
  const { error } = await sb.from('start_sessions').update({ alarm_cleared:true }).in('id', overIds);
  if(error){ console.error(error); return; }
  overIds.forEach(id=>{ const a=startState.active.find(x=>x.id===id); if(a) a.alarmCleared=true; });
}
 
/* ---- 실시간 ---- */
function startSubscribe(){
  if(startState.channel) sb.removeChannel(startState.channel);
  startState.channel=sb.channel('start_'+session.branchId)
    .on('postgres_changes', { event:'*', schema:'public', table:'start_sessions', filter:`branch_id=eq.${session.branchId}` },
      payload=>startHandleRealtime(payload))
    .subscribe();
}
function startHandleRealtime(payload){
  if(payload.eventType==='DELETE'){
    const oldId=payload.old && payload.old.id; if(!oldId) return;
    startState.active=startState.active.filter(a=>a.id!==oldId);
    startState.logRows=startState.logRows.filter(l=>l.id!==oldId);
    startRenderCards(); startSyncOverlay();
    if(document.getElementById('modalOverlay') && document.getElementById('modalOverlay').style.display!=='none') startOpenLogModal();
    return;
  }
  const row=payload.new;
  if(!row || row.date!==startState.viewDate) return;
  if(payload.eventType==='INSERT'){
    const r=startFromRow(payload.new);
    if(r.status==='out' && !startState.active.some(a=>a.id===r.id)){ startState.active.unshift(r); startRenderCards(); startSyncOverlay(); }
  } else if(payload.eventType==='UPDATE'){
    const r=startFromRow(payload.new);
    if(r.status==='returned'){
      startState.active=startState.active.filter(a=>a.id!==r.id);
      if(!startState.logRows.some(l=>l.id===r.id)) startState.logRows.unshift(r);
      startRenderCards(); startSyncOverlay(); return;
    }
    const cur=startState.active.find(a=>a.id===r.id);
    if(cur){ cur.alarmCleared=r.alarmCleared; startSyncOverlay(); }
  }
}
 
/* ---- 초과 알림 ---- */
function startFireAlarm(a){
  startBeep();
  startSystemNotify(a.name, a.limitSec);
  startShowOverlay();
}
function startSystemNotify(name, limitSec){
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  try{
    const n=new Notification('STaRT 시간 초과', {
      body:`${name} 학생이 ${Math.round(limitSec/60)}분을 넘겼습니다. 복귀 확인이 필요합니다.`,
      tag:'start-'+name+'-'+Date.now(), requireInteraction:true });
    n.onclick=()=>{ window.focus(); n.close(); };
  }catch(e){ console.warn(e); }
}
let startAudioCtx=null;
function startUnlockAudio(){ if(startAudioCtx && startAudioCtx.state==='suspended') startAudioCtx.resume(); }
function startBeep(){
  if(startState.muted) return;
  try{
    startAudioCtx=startAudioCtx||new (window.AudioContext||window.webkitAudioContext)();
    let t=startAudioCtx.currentTime;
    for(let i=0;i<3;i++){
      const o=startAudioCtx.createOscillator(),g=startAudioCtx.createGain();
      o.connect(g);g.connect(startAudioCtx.destination);
      o.type='square';o.frequency.value=i%2?660:880;
      g.gain.setValueAtTime(0.001,t);g.gain.exponentialRampToValueAtTime(0.25,t+0.02);
      g.gain.exponentialRampToValueAtTime(0.001,t+0.3);
      o.start(t);o.stop(t+0.32);t+=0.34;
    }
  }catch(e){}
}
 
/* ---- 오버레이 ---- */
function startShowOverlay(){
  let ov=document.getElementById('stOverlay');
  if(!ov){
    ov=document.createElement('div'); ov.id='stOverlay';
    ov.innerHTML=`<div class="st-ov-inner">
      <div class="st-ov-tag"><i class="ti ti-clock-exclamation" style="font-size:18px"></i>시간 초과</div>
      <div class="st-ov-names" id="stOvNames"></div>
      <div class="st-ov-sub">복귀 확인이 필요합니다</div>
      <button class="st-ov-btn" onclick="startClearAlarm()">확인했습니다</button>
    </div>`;
    document.body.appendChild(ov);
  }
  startUpdateOverlay();
  ov.style.display='flex';
}
function startUpdateOverlay(){
  const box=document.getElementById('stOvNames'); if(!box) return;
  const now=new Date();
  const over=startState.active.filter(a=>{ const e=Math.floor((now-new Date(a.leftAt))/1000); return e>=a.limitSec && !a.alarmCleared; });
  if(!over.length){ startCloseOverlay(); return; }
  box.innerHTML=over.map(a=>{
    const e=Math.floor((now-new Date(a.leftAt))/1000);
    const k=a.kind==='exam'?'시험':'외출';
    return `<div class="st-ov-row"><span class="st-ov-name">${esc(a.name)}</span><span class="st-ov-over">${k} +${startDur(e-a.limitSec)}</span></div>`;
  }).join('');
}
function startCloseOverlay(){ const ov=document.getElementById('stOverlay'); if(ov) ov.style.display='none'; }
function startSyncOverlay(){
  const now=new Date();
  const anyOver=startState.active.some(a=>{ const e=Math.floor((now-new Date(a.leftAt))/1000); return e>=a.limitSec && !a.alarmCleared; });
  if(anyOver) startShowOverlay(); else startCloseOverlay();
}
 
/* ---- CSV ---- */
function startDownloadCSV(){
  if(!startState.logRows.length){ toast('기록이 없습니다','err'); return; }
  const rows=[['구분','이름','반','담임','시작','복귀','소요(분:초)','제한(분)','결과']];
  startState.logRows.slice().reverse().forEach(r=>{
    const elp=r.returnedAt?Math.round((new Date(r.returnedAt)-new Date(r.leftAt))/1000):null;
    const over=elp!=null && elp>r.limitSec;
    rows.push([r.kind==='exam'?'시험':'외출', r.name, r.cls||'', r.teacher||'', startHM(r.leftAt),
      r.returnedAt?startHM(r.returnedAt):'', elp!=null?startDur(elp):'', Math.round(r.limitSec/60), over?'초과':'정상']);
  });
  const csv='\uFEFF'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`STaRT_${getBranch(session.branchId)?.name||session.branchId}_${startState.viewDate}.csv`;
  a.click();
}
function startRowHTML(a){
  const meta=[a.cls,a.teacher].filter(Boolean).join(' · ');
  const doneLabel = a.kind==='exam' ? '시험완료' : '복귀';
  return `<div class="st-row" data-id="${a.id}">
    <div class="st-row-info">
      <div class="st-row-name">${esc(a.name)}<span class="st-row-badge">초과</span></div>
      <div class="st-row-meta">${esc(meta||'—')} · 시작 ${startHM(a.leftAt)}</div>
    </div>
    <div class="st-row-timer">00:00</div>
    <div class="st-row-acts">
      <button class="st-mini ret" onclick="startReturn('${a.id}')">${doneLabel}</button>
      <button class="st-mini can" onclick="startCancel('${a.id}')">취소</button>
    </div>
  </div>`;
}
 
function startOnKeydown(e){
  const box=el('stAc');
  const open = box && box.style.display==='block' && startAcList.length>0;
  if(e.key==='ArrowDown'){
    if(open){ e.preventDefault(); startAcSel=Math.min(startAcSel+1,startAcList.length-1); startUpdateAcSel(); }
    return;
  }
  if(e.key==='ArrowUp'){
    if(open){ e.preventDefault(); startAcSel=Math.max(startAcSel-1,0); startUpdateAcSel(); }
    return;
  }
  if(e.key==='ArrowLeft' || e.key==='ArrowRight'){
    if(!el('stInput').value){ e.preventDefault(); startSetMode(startMode==='exam'?'outing':'exam'); }
    return;
  }
  if(e.key==='Enter'){
    e.preventDefault();
    if(open && startAcSel>=0){ startAdd(startAcList[startAcSel]); return; }
    const m=startFindStudents(el('stInput').value);
    if(m.length===1) startAdd(m[0]);
    else if(m.length>1) startOnInput();
    else toast('일치하는 학생이 없습니다','err');
    return;
  }
  if(e.key==='Escape'){ if(box) box.style.display='none'; }
}
 
function startOpenLogModal(){
  const rows=startState.logRows;
  const body=rows.length? rows.map(r=>{
    const el2=r.returnedAt?Math.round((new Date(r.returnedAt)-new Date(r.leftAt))/1000):null;
    const over=el2!=null&&el2>r.limitSec;
    const k=r.kind==='exam'?'시험':'외출';
    const kc=r.kind==='exam'?'#185FA5':'#0F6E56';
    return `<tr>
      <td><span style="font-size:11px;font-weight:800;color:${kc}">${k}</span></td>
      <td style="font-weight:700">${esc(r.name)}</td>
      <td style="color:var(--ink-2)">${esc(r.cls||'—')}</td>
      <td style="color:var(--ink-2)">${esc(r.teacher||'—')}</td>
      <td class="num">${startHM(r.leftAt)}</td>
      <td class="num">${r.returnedAt?startHM(r.returnedAt):'—'}</td>
      <td class="num">${el2!=null?startDur(el2):'—'}</td>
      <td style="font-weight:700;color:${over?'var(--neg)':'var(--pos)'}">${over?'초과':'정상'}</td>
      <td class="cc"><button class="btn sm" style="color:var(--neg)" onclick="startDeleteLog('${r.id}')">삭제</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--ink-3)">이 날짜의 기록이 없습니다</td></tr>`;

  openModal(`
    <div class="modal-head">
      <div>
        <h3>STaRT 기록</h3>
        <p style="font-size:12.5px;color:var(--ink-3);margin-top:2px">${startState.viewDate} · 총 ${rows.length}명</p>
      </div>
      <button class="modal-x" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-bottom:14px">
        <input type="date" id="stDate" value="${startState.viewDate}" class="st-inp" style="height:36px">
        <button class="btn sm" id="stCsvBtn">📥 CSV 내려받기</button>
      </div>
      <table class="grid" style="width:100%">
        <thead><tr>
          <th>구분</th><th>이름</th><th>반</th><th>담임</th><th>시작</th><th>복귀</th><th>소요</th><th>결과</th><th></th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`);

  const mb=document.getElementById('modalBox');
  if(mb){ mb.style.maxWidth='min(1080px,94vw)'; mb.style.width='min(1080px,94vw)'; }

  const d=el('stDate'); if(d) d.onchange=()=>{ startState.viewDate=d.value; startLoadSessions(startState.viewDate).then(()=>startOpenLogModal()); };
  const c=el('stCsvBtn'); if(c) c.onclick=startDownloadCSV;
}
 
function startInjectStyles(){
  const old3=document.getElementById('stV3Style'); if(old3) old3.remove();
  const old4=document.getElementById('stV4Style'); if(old4) old4.remove();
  if(document.getElementById('stV5Style')) return;
  const st=document.createElement('style'); st.id='stV5Style';
  st.textContent=`
    .st-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .st-col{border-radius:14px;padding:12px}
    .st-col-exam{background:#F4F8FD;border:1px solid #D3E4F5}
    .st-col-outing{background:#F3FAF6;border:1px solid #C9E9DC}
    .st-col-head{display:flex;align-items:center;gap:8px;padding:2px 4px 12px;margin-bottom:12px;font-size:16px;font-weight:800;border-bottom:1px solid rgba(0,0,0,.06)}
    .st-col-exam .st-col-head{color:#0C447C}.st-col-exam .st-col-head i{color:#185FA5}
    .st-col-outing .st-col-head{color:#085041}.st-col-outing .st-col-head i{color:#0F6E56}
    .st-col-cnt{margin-left:auto;font-size:13px;font-weight:700;border-radius:999px;padding:2px 10px}
    .st-col-exam .st-col-cnt{background:#E6F1FB;color:#185FA5}
    .st-col-outing .st-col-cnt{background:#E1F5EE;color:#0F6E56}
    .st-list{display:flex;flex-direction:column;gap:8px}
    .st-over-zone:not(:empty){margin-bottom:8px}
    .st-empty{text-align:center;color:var(--ink-3);font-size:13px;padding:24px 0}
    .st-row{display:flex;align-items:center;gap:12px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:9px 12px}
    .st-row-info{flex:1;min-width:0}
    .st-row-name{font-size:16px;font-weight:700;color:var(--ink-1);display:flex;align-items:center;gap:6px}
    .st-row-badge{display:none;font-size:11px;font-weight:800;color:#fff;background:var(--neg);border-radius:5px;padding:1px 7px}
    .st-row-meta{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .st-row-timer{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--pos);letter-spacing:-.5px;min-width:64px;text-align:right}
    .st-row-acts{display:flex;gap:6px;flex-shrink:0}
    .st-mini{height:34px;padding:0 14px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;white-space:nowrap}
    .st-mini.ret{background:var(--brand);color:#fff}
    .st-mini.can{background:var(--surface-1);color:var(--ink-3);border:1px solid var(--line)}
    .st-row.over{background:#FCEEEE;border-color:var(--neg);animation:stFlash .9s infinite}
    .st-row.over .st-row-badge{display:inline-block}
    @keyframes stFlash{0%,100%{background:#FCEEEE}50%{background:#f7dede}}
    .st-inp{height:40px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);font-size:15px}
    .st-modetog{display:inline-flex;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden;height:40px}
    .st-mode-btn{border:none;background:transparent;padding:0 16px;font-size:15px;font-weight:700;color:var(--ink-3);cursor:pointer;display:flex;align-items:center;gap:6px}
    .st-mode-btn.active{background:var(--brand);color:#fff}
    .wd-item.sel{background:var(--surface-1);outline:2px solid var(--brand);outline-offset:-2px}
    #stOverlay{position:fixed;inset:0;z-index:9999;background:#1a1416;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;animation:stOvIn .25s ease-out}
    @keyframes stOvIn{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
    #stOverlay::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:#c0392b}
    .st-ov-tag{display:inline-flex;align-items:center;gap:8px;background:rgba(192,57,43,.15);border:1px solid rgba(192,57,43,.5);border-radius:999px;padding:7px 18px;margin-bottom:28px;font-size:14px;font-weight:500;color:#e8a0a0;letter-spacing:2px}
    .st-ov-names{display:flex;flex-direction:column;gap:14px;margin-bottom:28px}
    .st-ov-row{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap}
    .st-ov-name{font-size:52px;font-weight:500;color:#fff;line-height:1;letter-spacing:-1px}
    .st-ov-over{font-size:15px;font-weight:500;color:#1a1416;background:#e74c3c;border-radius:8px;padding:5px 12px}
    .st-ov-sub{font-size:16px;color:rgba(255,255,255,.6);margin-bottom:32px}
    .st-ov-btn{background:#fff;color:#1a1416;border:none;border-radius:12px;font-size:17px;font-weight:500;padding:14px 48px;cursor:pointer}
    .st-ov-btn:hover{opacity:.9}
    @media(max-width:900px){.st-columns{grid-template-columns:1fr}}`;
  document.head.appendChild(st);
}
/* ============================================================================
   STaRT 전체 키보드 내비게이션 — 아래 3개를 app.js에서 찾아 교체 + 1개 추가
     · startBindUI      (교체)
     · startOnKeydown   (교체)
     · startSetMode     (교체)
     · startFocusStep   (추가 — 함수 밖 아무 데나)
   ----------------------------------------------------------------------------
   동작:
   ←→ : 상단 컨트롤 이동 (시험/외출 → 기본시간 → 이름 → 등록 → 소리 → 알림허용)
   ↑↓ : 시간 드롭다운 열기·선택 / 이름칸에서 자동완성 학생 선택
   Enter : 현재 위치 실행
   ============================================================================ */

/* 상단 컨트롤 이동 순서 */
function startFocusSteps(){
  // 실제 존재하는 것만 순서대로
  return ['stModeExam','stModeOuting','stMin','stInput','stAddBtn','stMuteBtn','stPermBtn']
    .map(id=>document.getElementById(id)).filter(Boolean);
}
function startFocusStep(dir){
  const steps=startFocusSteps();
  if(!steps.length) return;
  const active=document.activeElement;
  let idx=steps.indexOf(active);
  if(idx<0) idx = dir>0 ? -1 : 0;
  idx = Math.min(steps.length-1, Math.max(0, idx+dir));
  const t=steps[idx];
  if(t){ t.focus(); if(t.tagName==='INPUT'&&t.type!=='number') t.select && t.select(); }
}

function startSetMode(mode){
  startMode=mode;
  const tog=el('stModeTog'); if(!tog) return;
  tog.querySelectorAll('.st-mode-btn').forEach(b=> b.classList.toggle('active', b.dataset.mode===mode));
}

function startBindUI(){
  const input=el('stInput');
  input.addEventListener('input', startOnInput);

  // 모드 버튼에 id 부여 (키보드 이동 대상)
  const tog=el('stModeTog');
  const modeBtns=tog.querySelectorAll('.st-mode-btn');
  modeBtns.forEach(btn=>{
    btn.id = btn.dataset.mode==='exam' ? 'stModeExam' : 'stModeOuting';
    btn.tabIndex=0;
    btn.onclick=()=>{ startSetMode(btn.dataset.mode); btn.focus(); };
  });

  el('stAddBtn').onclick=()=>{
    const m=startFindStudents(input.value);
    if(m.length===1) startAdd(m[0]);
    else if(m.length>1){ startOnInput(); toast('여러 명 검색됨 — ↑↓로 선택'); }
    else toast('일치하는 학생이 없습니다','err');
  };
  el('stMuteBtn').onclick=()=>{ startState.muted=!startState.muted; el('stMuteBtn').textContent=startState.muted?'🔇':'🔊'; };
  el('stPermBtn').onclick=startAskPerm;
  el('stLogBtn').onclick=startOpenLogModal;

  // 전역 키다운 (상단 영역에서 ←→ 이동)
  document.addEventListener('keydown', startGlobalKey, true);
  input.addEventListener('keydown', startOnKeydown);
  document.addEventListener('click', startDocClick);
}

/* 상단 컨트롤 위에서 방향키 처리 (input은 startOnKeydown이 먼저 잡음) */
function startGlobalKey(e){
  if(!document.getElementById('stModeTog')) return;
  const active=document.activeElement;
  if(!startFocusSteps().includes(active)) return;
  if(active && active.id==='stInput') return;

  if(active.id==='stMin' && (e.key==='ArrowUp'||e.key==='ArrowDown')) return;

  if(e.key==='ArrowRight'){ e.preventDefault(); e.stopPropagation(); startFocusStep(1); return; }
  if(e.key==='ArrowLeft'){ e.preventDefault(); e.stopPropagation(); startFocusStep(-1); return; }

  if(e.key==='Enter'||e.key===' '){
    if(active.classList && active.classList.contains('st-mode-btn')){
      e.preventDefault(); startSetMode(active.dataset.mode); return;
    }
    if(active.tagName==='BUTTON'){ e.preventDefault(); active.click(); }
  }
}

/* 이름 입력칸 전용 키 처리 */
function startOnKeydown(e){
  const box=el('stAc');
  const open = box && box.style.display==='block' && startAcList.length>0;

  // 자동완성 목록이 떠 있으면 ↑↓ = 학생 선택
  if(e.key==='ArrowDown'){
    if(open){ e.preventDefault(); startAcSel=Math.min(startAcSel+1,startAcList.length-1); startUpdateAcSel(); }
    return;
  }
  if(e.key==='ArrowUp'){
    if(open){ e.preventDefault(); startAcSel=Math.max(startAcSel-1,0); startUpdateAcSel(); }
    return;
  }
  // ←→ = 칸 이동 (이름칸도 무조건 이동)
  if(e.key==='ArrowLeft'){ e.preventDefault(); if(box) box.style.display='none'; startFocusStep(-1); return; }
  if(e.key==='ArrowRight'){ e.preventDefault(); if(box) box.style.display='none'; startFocusStep(1); return; }

  if(e.key==='Enter'){
    e.preventDefault();
    if(open && startAcSel>=0){ startAdd(startAcList[startAcSel]); return; }
    const m=startFindStudents(el('stInput').value);
    if(m.length===1) startAdd(m[0]);
    else if(m.length>1) startOnInput();
    else toast('일치하는 학생이 없습니다','err');
    return;
  }
  if(e.key==='Escape'){ if(box) box.style.display='none'; }
}
/* ============================================================================
   CHESS / ACE 판정 — app.js 아무 데나(함수 밖) 붙여넣기
   반 이름(className)에서 레벨 코드를 뽑아 CHESS인지 ACE인지 판정.
   예: "[IS2]SU1/MWF/IS2/J" → 레벨 "IS" → CHESS
       "[LSA1]SP1/MWF/E"    → 레벨 "LSA" → CHESS
       "[A1]SU2/TTH"        → 레벨 "A"  → ACE
       "[HM2]..."           → 레벨 "HM" → ACE
   ============================================================================ */

/* CHESS 레벨 목록 (이 알파벳으로 시작하면 CHESS, 나머지는 ACE) */
const CHESS_LEVELS = ['IS','DSA','DSB','DSC','DSD','LSA','LSB','LSC','LSD','MSA','MSB'];

/* 반 이름에서 레벨 알파벳만 추출: "[LSA1]SP1/..." → "LSA" */
function levelAlphaOf(className){
  const m = String(className||'').match(/^\s*\[([A-Za-z]+)/);  // 대괄호 안 알파벳만 (숫자 앞까지)
  return m ? m[1].toUpperCase() : '';
}

/* CHESS 여부 판정 → true=CHESS, false=ACE */
function isChess(className){
  const alpha = levelAlphaOf(className);
  if(!alpha) return false;  // 레벨 못 읽으면 일단 ACE로
  return CHESS_LEVELS.includes(alpha);
}

/* 구분 라벨 반환: 'CHESS' | 'ACE' */
function chessAceOf(className){
  return isChess(className) ? 'CHESS' : 'ACE';
}

/* 레코드 배열을 받아 {chess, ace, total} 개수로 집계 */
function countChessAce(records){
  let chess=0, ace=0;
  records.forEach(r=>{
    if(isChess(r.className)) chess++; else ace++;
  });
  return { chess, ace, total: chess+ace };
}

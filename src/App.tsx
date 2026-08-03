import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FolderOpen, Plus, RefreshCw, Save, Trash2, Upload, X } from "lucide-react";
import { fallbackOperators, type Operator } from "./data/operators";
import { squads as fallbackSquads, stages as fallbackStages, themes, type Stage } from "./data/stages";
import type { CellState, Elite, RunOperator, RunState, Skill, TimelineNode, TrackerStore } from "./types";

const STORAGE_KEY = "arknights-is-tracker:v2";
const rarityColor: Record<number, string> = { 6: "#f59e0b", 5: "#facc15", 4: "#a855f7", 3: "#1d4ed8", 2: "#22c55e", 1: "#9ca3af" };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;

function createRun(name = `新记录 ${new Date().toLocaleString("zh-CN")}`): RunState {
  return {
    id: uid(), name, theme: themes[0], squad: fallbackSquads[0], createdAt: now(), updatedAt: now(),
    nodes: [{ id: uid(), floor: 0, type: "initial", name: "初始招募 / 分队" }], operators: [],
  };
}

function loadStore(): TrackerStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as TrackerStore | null;
    if (parsed?.schemaVersion === 2 && parsed.runs.length) return parsed;
  } catch { /* ignore damaged local data */ }
  const run = createRun();
  return { schemaVersion: 2, activeRunId: run.id, runs: [run] };
}

function App() {
  const [store, setStore] = useState<TrackerStore>(loadStore);
  const [operators, setOperators] = useState<Operator[]>(fallbackOperators);
  const [stages, setStages] = useState<Stage[]>(fallbackStages);
  const [squads, setSquads] = useState<{ id: string; theme: string; name: string }[]>(themes.flatMap((theme) => fallbackSquads.map((name) => ({ id: `${theme}|${name}`, theme, name }))));
  const [dataStatus, setDataStatus] = useState("正在检查 PRTS 数据…");
  const [showOperatorPicker, setShowOperatorPicker] = useState(false);
  const [showStagePicker, setShowStagePicker] = useState(false);
  const [showRunManager, setShowRunManager] = useState(false);
  const [editingCell, setEditingCell] = useState<{ operatorId: string; nodeId: string } | null>(null);
  const [search, setSearch] = useState("");
  const [operatorRarity, setOperatorRarity] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(0);
  const [operatorAvailability, setOperatorAvailability] = useState<"all" | "available" | "added">("available");
  const [operatorPickerSort, setOperatorPickerSort] = useState<"rarity-desc" | "rarity-asc" | "name-asc">("rarity-desc");
  const [sortBy, setSortBy] = useState<"recruit" | "rarity" | "deploy">("recruit");
  const importRef = useRef<HTMLInputElement>(null);

  const run = store.runs.find((item) => item.id === store.activeRunId) ?? store.runs[0];

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store)), [store]);
  useEffect(() => {
    Promise.all([
      fetch(asset("data/operators.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : Promise.reject()),
      fetch(asset("data/stages.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : Promise.reject()),
      fetch(asset("data/squads.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : []),
      fetch(asset("data/manifest.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : null),
    ]).then(([opData, stageData, squadData, manifest]) => {
      if (Array.isArray(opData) && opData.length) setOperators(opData);
      if (Array.isArray(stageData) && stageData.length) setStages(stageData);
      if (Array.isArray(squadData) && squadData.length) setSquads(squadData);
      setDataStatus(manifest?.updatedAt ? `PRTS 数据：${new Date(manifest.updatedAt).toLocaleString("zh-CN")}` : "已加载本地 PRTS 数据");
    }).catch(() => setDataStatus("使用内置数据；下次启动会再次检查"));
  }, []);

  const operatorMap = useMemo(() => Object.fromEntries(operators.map((op) => [op.id, op])), [operators]);
  const availableSquads = useMemo(() => squads.filter((item) => item.theme === run.theme), [squads, run.theme]);
  const pickerOperators = useMemo(() => {
    const added = new Set(run.operators.map((row) => row.operatorId));
    const rows = operators.filter((op) => {
      if (search && !op.name.toLocaleLowerCase("zh-CN").includes(search.toLocaleLowerCase("zh-CN"))) return false;
      if (operatorRarity && op.rarity !== operatorRarity) return false;
      if (operatorAvailability === "available" && added.has(op.id)) return false;
      if (operatorAvailability === "added" && !added.has(op.id)) return false;
      return true;
    });
    rows.sort((a, b) => {
      if (operatorPickerSort === "rarity-desc") return b.rarity - a.rarity || a.name.localeCompare(b.name, "zh-CN");
      if (operatorPickerSort === "rarity-asc") return a.rarity - b.rarity || a.name.localeCompare(b.name, "zh-CN");
      return a.name.localeCompare(b.name, "zh-CN");
    });
    return rows;
  }, [operators, run.operators, search, operatorRarity, operatorAvailability, operatorPickerSort]);
  const sortedRows = useMemo(() => {
    const rows = [...run.operators];
    if (sortBy === "rarity") rows.sort((a, b) => (operatorMap[b.operatorId]?.rarity ?? 0) - (operatorMap[a.operatorId]?.rarity ?? 0));
    if (sortBy === "deploy") rows.sort((a, b) => countDeploys(b) - countDeploys(a));
    return rows;
  }, [run.operators, sortBy, operatorMap]);
  const floorGroups = useMemo(() => {
    const groups: Array<{ floor: number; count: number }> = [];
    for (const node of run.nodes) {
      const last = groups.at(-1);
      if (last?.floor === node.floor) last.count++;
      else groups.push({ floor: node.floor, count: 1 });
    }
    return groups;
  }, [run.nodes]);

  function updateRun(updater: (current: RunState) => RunState) {
    setStore((prev) => ({ ...prev, runs: prev.runs.map((item) => item.id === run.id ? { ...updater(item), updatedAt: now() } : item) }));
  }
  function addOperator(op: Operator) {
    if (run.operators.some((row) => row.operatorId === op.id)) return;
    updateRun((current) => ({ ...current, operators: [...current.operators, { operatorId: op.id, cells: {} }] }));
  }
  function addStage(stageId: string) {
    const stage = stages.find((item) => item.id === stageId); if (!stage) return;
    updateRun((current) => {
      const node = { id: uid(), floor: stage.floor, type: "combat" as const, stageId: stage.id, name: stage.name };
      const next = [...current.nodes];
      let insertAt = next.length;
      for (let i = 1; i < next.length; i++) if (next[i].floor > stage.floor) { insertAt = i; break; }
      next.splice(insertAt, 0, node);
      return { ...current, nodes: next };
    });
    setShowStagePicker(false);
  }
  function removeNode(nodeId: string) {
    updateRun((current) => ({
      ...current, nodes: current.nodes.filter((node) => node.id !== nodeId || node.type === "initial"),
      operators: current.operators.map((row) => { const cells = { ...row.cells }; delete cells[nodeId]; return { ...row, cells }; }),
    }));
  }
  function updateCell(operatorId: string, nodeId: string, patch: Partial<CellState>) {
    updateRun((current) => ({ ...current, operators: current.operators.map((row) => {
      if (row.operatorId !== operatorId) return row;
      const previous = row.cells[nodeId] ?? {};
      return { ...row, cells: { ...row.cells, [nodeId]: { ...previous, ...patch } } };
    }) }));
  }
  function exportStore() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `arknights-is-records-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  }
  function importStore(file: File) {
    file.text().then((text) => {
      const parsed = JSON.parse(text) as TrackerStore;
      if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.runs)) throw new Error("格式不正确");
      setStore(parsed); setShowRunManager(false);
    }).catch((error) => alert(`读取失败：${error.message}`));
  }

  return <div className="app-shell">
    <header className="topbar">
      <div><div className="eyebrow">ARKNIGHTS ROGUELIKE</div><h1>集成战略记录器</h1><div className="data-status">{dataStatus}</div></div>
      <div className="top-actions">
        <button className="ghost-button" onClick={() => setShowRunManager(true)}><FolderOpen size={16}/> 记录</button>
        <button className="ghost-button" onClick={exportStore}><Download size={16}/> 导出</button>
        <button className="ghost-button" onClick={() => importRef.current?.click()}><Upload size={16}/> 导入</button>
        <input ref={importRef} hidden type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importStore(e.target.files[0])}/>
      </div>
    </header>

    <section className="toolbar panel">
      <label>记录名称<input value={run.name} onChange={(e) => updateRun((r) => ({ ...r, name: e.target.value }))}/></label>
      <label>集成战略<select value={run.theme} onChange={(e) => { const theme = e.target.value; const firstSquad = squads.find((item) => item.theme === theme)?.name ?? fallbackSquads[0]; updateRun((r) => ({ ...r, theme, squad: firstSquad })); }}>{themes.map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>分队<select value={run.squad} onChange={(e) => updateRun((r) => ({ ...r, squad: e.target.value }))}>{availableSquads.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select></label>
      <label>行排序<select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}><option value="recruit">添加顺序</option><option value="rarity">星级降序</option><option value="deploy">出场次数</option></select></label>
      <div className="toolbar-actions"><button onClick={() => setShowOperatorPicker(true)}><Plus size={16}/> 添加干员</button><button onClick={() => setShowStagePicker(true)}><Plus size={16}/> 添加关卡</button></div>
    </section>

    <section className="timeline-panel panel"><div className="timeline-scroll"><div className="timeline-grid" style={{gridTemplateColumns:`210px repeat(${run.nodes.length}, 122px)`}}>
      <div className="corner floor-header sticky-left">干员 / 楼层</div>
      {floorGroups.map((g,i)=><div key={`${g.floor}-${i}`} className="floor-header" style={{gridColumn:`span ${g.count}`}}>{g.floor===0?"初始":`第 ${g.floor} 层`}</div>)}
      <div className="corner node-header sticky-left">节点</div>
      {run.nodes.map((node)=><div className="node-header" key={node.id}><div className="node-title">{node.name}</div><div className="node-actions">{node.stageId&&<a href={stages.find(s=>s.id===node.stageId)?.prtsUrl} target="_blank" rel="noreferrer"><ExternalLink size={14}/></a>}{node.type!=="initial"&&<button onClick={()=>removeNode(node.id)}><Trash2 size={14}/></button>}</div></div>)}
      {sortedRows.map((row)=>{const op=operatorMap[row.operatorId]; return op?<TimelineRow key={row.operatorId} row={row} operator={op} nodes={run.nodes} onRemove={()=>updateRun(r=>({...r,operators:r.operators.filter(x=>x.operatorId!==row.operatorId)}))} onEdit={(nodeId)=>setEditingCell({operatorId:row.operatorId,nodeId})}/>:null;})}
    </div></div></section>
    <Stats run={run} operatorMap={operatorMap}/>
    <AggregateStats store={store} operatorMap={operatorMap}/>

    {showOperatorPicker&&<Modal title="添加干员" onClose={()=>setShowOperatorPicker(false)}>
      <div className="picker-controls">
        <input autoFocus className="search-input" placeholder="搜索干员名称" value={search} onChange={(e)=>setSearch(e.target.value)}/>
        <select value={operatorRarity} onChange={(e)=>setOperatorRarity(Number(e.target.value) as 0|1|2|3|4|5|6)} aria-label="按星级筛选">
          <option value={0}>全部星级</option>{[6,5,4,3,2,1].map(r=><option value={r} key={r}>{r} 星</option>)}
        </select>
        <select value={operatorAvailability} onChange={(e)=>setOperatorAvailability(e.target.value as "all"|"available"|"added")} aria-label="按添加状态筛选">
          <option value="available">仅未添加</option><option value="all">全部干员</option><option value="added">仅已添加</option>
        </select>
        <select value={operatorPickerSort} onChange={(e)=>setOperatorPickerSort(e.target.value as "rarity-desc"|"rarity-asc"|"name-asc")} aria-label="干员排序">
          <option value="rarity-desc">星级：高到低</option><option value="rarity-asc">星级：低到高</option><option value="name-asc">名称排序</option>
        </select>
      </div>
      <div className="picker-summary">显示 {pickerOperators.length} / {operators.length} 名干员</div>
      <div className="picker-grid">{pickerOperators.map(op=><button className="picker-item" key={op.id} onClick={()=>addOperator(op)} disabled={run.operators.some(r=>r.operatorId===op.id)}><OperatorAvatar operator={op} size={62}/><span>{op.name}</span><small>{op.rarity}★{run.operators.some(r=>r.operatorId===op.id)?" · 已添加":""}</small></button>)}</div>
    </Modal>}
    {showStagePicker&&<Modal title="添加关卡" onClose={()=>setShowStagePicker(false)}><div className="stage-list">{stages.filter(s=>s.theme===run.theme).sort((a,b)=>a.floor-b.floor||a.name.localeCompare(b.name,"zh-CN")).map(s=><button key={s.id} className="stage-item" onClick={()=>addStage(s.id)}><span>第 {s.floor} 层</span><strong>{s.name}</strong></button>)}</div></Modal>}
    {editingCell&&<CellEditor operator={operatorMap[editingCell.operatorId]} node={run.nodes.find(n=>n.id===editingCell.nodeId)!} row={run.operators.find(r=>r.operatorId===editingCell.operatorId)!} nodes={run.nodes} onChange={(patch)=>updateCell(editingCell.operatorId,editingCell.nodeId,patch)} onClose={()=>setEditingCell(null)}/>} 
    {showRunManager&&<RunManager store={store} onClose={()=>setShowRunManager(false)} onSelect={(id)=>setStore(s=>({...s,activeRunId:id}))} onCreate={()=>{const newRun=createRun();setStore(s=>({...s,activeRunId:newRun.id,runs:[...s.runs,newRun]}));}} onDelete={(id)=>setStore(s=>{if(s.runs.length===1)return s;const runs=s.runs.filter(r=>r.id!==id);return{...s,runs,activeRunId:s.activeRunId===id?runs[0].id:s.activeRunId};})}/>} 
  </div>;
}

function TimelineRow({row,operator,nodes,onRemove,onEdit}:{row:RunOperator;operator:Operator;nodes:TimelineNode[];onRemove:()=>void;onEdit:(id:string)=>void}) {
  return <><div className="operator-label sticky-left"><OperatorAvatar operator={operator} size={50}/><div className="operator-text"><a href={operator.prtsUrl} target="_blank" rel="noreferrer">{operator.name}</a><span>{operator.rarity}★ · 出场 {countDeploys(row)}</span></div><button onClick={onRemove}><X size={15}/></button></div>{nodes.map((node,index)=>{const state=row.cells[node.id]??{};const recruitedIndex=nodes.findIndex(n=>Boolean(row.cells[n.id]?.recruitType));const owned=recruitedIndex>=0&&index>=recruitedIndex;const effective=resolveEffectiveState(row,nodes,index);return <button key={node.id} className={`timeline-cell ${owned?"owned":""}`} onClick={()=>onEdit(node.id)}>{owned&&<span className="connector"/>}{(state.recruitType||state.deployed)&&<OperatorAvatar operator={operator} state={{...state,elite:effective.elite,recruitType:effective.recruitType}} size={68}/>}</button>;})}</>;
}

function OperatorAvatar({operator,state,size=58}:{operator:Operator;state?:CellState;size?:number}) {
  const temporary=state?.recruitType==="temporary"; const skill=state?.skill ? operator.skills.find(s=>s.index===state.skill) : undefined;
  return <div className="avatar-ring" style={{width:size,height:size,background:temporary?`conic-gradient(#7dd3fc 0deg 180deg, ${rarityColor[operator.rarity]} 180deg 360deg)`:rarityColor[operator.rarity]}} title={`${operator.name} · ${operator.rarity}星`}><img src={operator.avatar || asset("icons/operator-fallback.svg")} alt={operator.name} onError={(e)=>{e.currentTarget.onerror=null;e.currentTarget.src=asset("icons/operator-fallback.svg");}}/>{state?.elite&&<img className="image-badge elite-image" src={asset(`icons/elite-${state.elite}.svg`)} alt={`精英化${state.elite}`}/>} {state?.deployed&&state.skill&&<img className="image-badge skill-image" src={skill?.icon||asset("icons/skill-fallback.svg")} alt={skill?.name||`技能${state.skill}`} title={skill?.name||`技能 ${state.skill}`} onError={(e)=>{e.currentTarget.src=asset("icons/skill-fallback.svg");}}/>}{state?.recruitType&&<span className="recruit-badge">+</span>}</div>;
}

function CellEditor({operator,node,row,nodes,onChange,onClose}:{operator:Operator;node:TimelineNode;row:RunOperator;nodes:TimelineNode[];onChange:(p:Partial<CellState>)=>void;onClose:()=>void}) {
  const index=nodes.findIndex(n=>n.id===node.id); const state=row.cells[node.id]??{}; const recruitIndex=nodes.findIndex(n=>Boolean(row.cells[n.id]?.recruitType)); const alreadyRecruited=recruitIndex>=0&&recruitIndex!==index; const effective=resolveEffectiveState(row,nodes,index); const maxPreviousElite=resolveEffectiveState(row,nodes,index-1).elite;
  return <Modal title={`${operator.name} · ${node.name}`} onClose={onClose}><div className="editor-form">
    <div><div className="field-title">招募方式（只能选择一次）</div><div className="segmented"><button disabled={alreadyRecruited} className={state.recruitType==="normal"?"active":""} onClick={()=>onChange({recruitType:state.recruitType==="normal"?undefined:"normal",elite:state.elite??1})}>普通招募</button><button disabled={alreadyRecruited} className={state.recruitType==="temporary"?"active":""} onClick={()=>onChange({recruitType:state.recruitType==="temporary"?undefined:"temporary",elite:state.elite??1})}>临时招募</button></div>{alreadyRecruited&&<p className="hint">该干员已经在更早的节点招募，不能再次招募。</p>}</div>
    <label className="check-row"><input type="checkbox" checked={Boolean(state.deployed)} disabled={!effective.recruitType} onChange={(e)=>onChange({deployed:e.target.checked,skill:e.target.checked?(state.skill??1):undefined})}/> 本关出场</label>
    <div><div className="field-title">精英化</div><div className="segmented image-options">{([1,2] as Elite[]).map(elite=><button key={elite} disabled={!effective.recruitType || (maxPreviousElite===2&&elite===1)} className={effective.elite===elite?"active":""} onClick={()=>onChange({elite})}><img src={asset(`icons/elite-${elite}.svg`)}/><span>精英化 {elite}</span></button>)}</div>{maxPreviousElite===2&&<p className="hint">此前已经精英化二，后续节点不能降回精英化一。</p>}</div>
    <div><div className="field-title">本关使用技能</div><div className="segmented image-options">{([1,2,3] as Skill[]).map(skill=>{const info=operator.skills.find(s=>s.index===skill);return <button key={skill} disabled={!effective.recruitType} className={state.deployed&&state.skill===skill?"active":""} onClick={()=>onChange({skill,deployed:true})}><img src={info?.icon||asset("icons/skill-fallback.svg")}/><span>{info?.name||`技能 ${skill}`}</span></button>})}</div></div>
  </div></Modal>;
}

function RunManager({store,onClose,onSelect,onCreate,onDelete}:{store:TrackerStore;onClose:()=>void;onSelect:(id:string)=>void;onCreate:()=>void;onDelete:(id:string)=>void}) { return <Modal title="保存与读取记录" onClose={onClose}><button className="wide-button" onClick={onCreate}><Plus size={16}/> 新建记录</button><div className="run-list">{[...store.runs].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(run=><div className={`run-card ${run.id===store.activeRunId?"active":""}`} key={run.id}><button className="run-open" onClick={()=>{onSelect(run.id);onClose();}}><strong>{run.name}</strong><span>{run.theme} · {new Date(run.updatedAt).toLocaleString("zh-CN")}</span></button><button className="danger-icon" disabled={store.runs.length===1} onClick={()=>onDelete(run.id)}><Trash2 size={16}/></button></div>)}</div></Modal> }
function Stats({run,operatorMap}:{run:RunState;operatorMap:Record<string,Operator>}) { const rows=run.operators.map(r=>({op:operatorMap[r.operatorId],deploys:countDeploys(r),s1:countSkill(r,1),s2:countSkill(r,2),s3:countSkill(r,3)})).filter(x=>x.op).sort((a,b)=>b.deploys-a.deploys||b.op.rarity-a.op.rarity); return <section className="panel stats-panel"><div className="eyebrow">STATISTICS</div><h2>干员使用统计</h2>{rows.length?<div className="stats-table-wrap"><table><thead><tr><th>干员</th><th>星级</th><th>出场</th><th>S1</th><th>S2</th><th>S3</th></tr></thead><tbody>{rows.map(r=><tr key={r.op.id}><td>{r.op.name}</td><td>{r.op.rarity}</td><td>{r.deploys}</td><td>{r.s1}</td><td>{r.s2}</td><td>{r.s3}</td></tr>)}</tbody></table></div>:<p className="muted">添加干员并记录出场后自动统计。</p>}</section> }

type AggregateSource = { id: string; label: string; run: RunState };
type AggregateRow = {
  op: Operator;
  normalRecruit: number;
  temporaryRecruit: number;
  normalDeploy: number;
  temporaryDeploy: number;
  totalDeploy: number;
  runsSeen: number;
};

function AggregateStats({store,operatorMap}:{store:TrackerStore;operatorMap:Record<string,Operator>}) {
  const [external, setExternal] = useState<AggregateSource[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("all");
  const [rarity, setRarity] = useState(0);
  const [recruitFilter, setRecruitFilter] = useState<"all"|"normal"|"temporary">("all");
  const [sort, setSort] = useState<"normalRecruit"|"temporaryRecruit"|"totalDeploy"|"temporaryDeploy"|"runsSeen"|"rarity"|"name">("normalRecruit");
  const [direction, setDirection] = useState<"desc"|"asc">("desc");
  const analysisInput = useRef<HTMLInputElement>(null);

  const sources = useMemo<AggregateSource[]>(() => [
    ...store.runs.map((run) => ({ id: `local:${run.id}`, label: `本地 · ${run.name}`, run })),
    ...external,
  ], [store.runs, external]);

  const selectedRuns = useMemo(() => sources.filter((source) => !excluded.has(source.id)).map((source) => source.run), [sources, excluded]);
  const themeOptions = useMemo(() => [...new Set(sources.map((source) => source.run.theme))], [sources]);

  const rows = useMemo(() => {
    const map = new Map<string, AggregateRow>();
    for (const run of selectedRuns) {
      if (theme !== "all" && run.theme !== theme) continue;
      for (const row of run.operators) {
        const op = operatorMap[row.operatorId];
        if (!op) continue;
        let aggregate = map.get(op.id);
        if (!aggregate) {
          aggregate = { op, normalRecruit: 0, temporaryRecruit: 0, normalDeploy: 0, temporaryDeploy: 0, totalDeploy: 0, runsSeen: 0 };
          map.set(op.id, aggregate);
        }
        const recruited = Object.values(row.cells).some((cell) => Boolean(cell.recruitType));
        if (recruited) aggregate.runsSeen += 1;
        for (const node of run.nodes) {
          const cell = row.cells[node.id];
          if (!cell) continue;
          if (cell.recruitType === "normal") aggregate.normalRecruit += 1;
          if (cell.recruitType === "temporary") aggregate.temporaryRecruit += 1;
          if (cell.deployed) {
            aggregate.totalDeploy += 1;
            const nodeIndex = run.nodes.findIndex((candidate) => candidate.id === node.id);
            const recruitType = resolveEffectiveState(row, run.nodes, nodeIndex).recruitType;
            if (recruitType === "temporary") aggregate.temporaryDeploy += 1;
            else aggregate.normalDeploy += 1;
          }
        }
      }
    }
    const result = [...map.values()].filter((row) => {
      if (query && !row.op.name.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN"))) return false;
      if (rarity && row.op.rarity !== rarity) return false;
      if (recruitFilter === "normal" && row.normalRecruit === 0) return false;
      if (recruitFilter === "temporary" && row.temporaryRecruit === 0) return false;
      return true;
    });
    result.sort((a, b) => {
      let comparison = 0;
      if (sort === "name") comparison = a.op.name.localeCompare(b.op.name, "zh-CN");
      else if (sort === "rarity") comparison = a.op.rarity - b.op.rarity;
      else comparison = a[sort] - b[sort];
      return (direction === "desc" ? -comparison : comparison) || b.totalDeploy - a.totalDeploy || b.op.rarity - a.op.rarity;
    });
    return result;
  }, [selectedRuns, operatorMap, theme, query, rarity, recruitFilter, sort, direction]);

  async function addAnalysisFiles(files: FileList) {
    const additions: AggregateSource[] = [];
    for (const file of Array.from(files)) {
      try {
        const parsed = JSON.parse(await file.text()) as TrackerStore | RunState;
        const runs = "runs" in parsed && Array.isArray(parsed.runs) ? parsed.runs : [parsed as RunState];
        for (const run of runs) {
          if (!run?.id || !Array.isArray(run.nodes) || !Array.isArray(run.operators)) throw new Error("缺少记录字段");
          additions.push({ id: `file:${file.name}:${run.id}:${uid()}`, label: `${file.name} · ${run.name}`, run });
        }
      } catch (error) {
        alert(`${file.name} 无法用于统计：${error instanceof Error ? error.message : "格式错误"}`);
      }
    }
    setExternal((current) => [...current, ...additions]);
  }

  function toggleSource(id: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return <section className="panel stats-panel aggregate-panel">
    <div className="aggregate-heading">
      <div><div className="eyebrow">MULTI-RUN ANALYSIS</div><h2>综合抓位与使用统计</h2><p className="muted">当前纳入 {selectedRuns.length} 个记录；导入的 JSON 仅用于分析，不会覆盖本地存档。</p></div>
      <div className="top-actions"><button className="ghost-button" onClick={() => analysisInput.current?.click()}><Upload size={16}/> 导入分析 JSON</button>{external.length>0&&<button className="ghost-button" onClick={()=>setExternal([])}><Trash2 size={16}/> 清除导入</button>}<input ref={analysisInput} hidden multiple type="file" accept="application/json" onChange={(event)=>event.target.files&&addAnalysisFiles(event.target.files)}/></div>
    </div>
    <details className="source-selector"><summary>选择参与统计的记录（{selectedRuns.length}/{sources.length}）</summary><div className="source-grid">{sources.map((source)=><label key={source.id} className="check-row"><input type="checkbox" checked={!excluded.has(source.id)} onChange={()=>toggleSource(source.id)}/><span>{source.label}</span><small>{source.run.theme}</small></label>)}</div></details>
    <div className="aggregate-controls">
      <input placeholder="搜索干员" value={query} onChange={(e)=>setQuery(e.target.value)}/>
      <select value={theme} onChange={(e)=>setTheme(e.target.value)}><option value="all">全部肉鸽</option>{themeOptions.map((value)=><option key={value}>{value}</option>)}</select>
      <select value={rarity} onChange={(e)=>setRarity(Number(e.target.value))}><option value={0}>全部星级</option>{[6,5,4,3,2,1].map((value)=><option key={value} value={value}>{value} 星</option>)}</select>
      <select value={recruitFilter} onChange={(e)=>setRecruitFilter(e.target.value as typeof recruitFilter)}><option value="all">全部招募类型</option><option value="normal">有普通招募</option><option value="temporary">有临时招募</option></select>
      <select value={sort} onChange={(e)=>setSort(e.target.value as typeof sort)}><option value="normalRecruit">普通抓取次数</option><option value="temporaryRecruit">临时抓取次数</option><option value="totalDeploy">总出场次数</option><option value="temporaryDeploy">临时干员出场</option><option value="runsSeen">出现局数</option><option value="rarity">星级</option><option value="name">名称</option></select>
      <select value={direction} onChange={(e)=>setDirection(e.target.value as typeof direction)}><option value="desc">降序</option><option value="asc">升序</option></select>
    </div>
    {rows.length?<div className="stats-table-wrap"><table><thead><tr><th>干员</th><th>星级</th><th>普通抓取</th><th>临时抓取</th><th>普通出场</th><th>临时出场</th><th>总出场</th><th>出现局数</th></tr></thead><tbody>{rows.map((row)=><tr key={row.op.id}><td><div className="stats-operator"><OperatorAvatar operator={row.op} size={34}/><span>{row.op.name}</span></div></td><td>{row.op.rarity}</td><td>{row.normalRecruit}</td><td>{row.temporaryRecruit}</td><td>{row.normalDeploy}</td><td>{row.temporaryDeploy}</td><td>{row.totalDeploy}</td><td>{row.runsSeen}</td></tr>)}</tbody></table></div>:<p className="muted">当前筛选条件下没有数据。</p>}
  </section>;
}

function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}) { return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e=>e.stopPropagation()}><div className="modal-header"><h3>{title}</h3><button onClick={onClose}><X size={18}/></button></div>{children}</div></div> }
function resolveEffectiveState(row:RunOperator,nodes:TimelineNode[],index:number):CellState { const result:CellState={}; if(index<0)return result; for(let i=0;i<=index;i++){const cell=row.cells[nodes[i].id];if(!cell)continue;if(cell.recruitType)result.recruitType=cell.recruitType;if(cell.elite&&(!result.elite||cell.elite>result.elite))result.elite=cell.elite;} return result; }
function countDeploys(row:RunOperator){return Object.values(row.cells).filter(c=>c.deployed).length;} function countSkill(row:RunOperator,skill:Skill){return Object.values(row.cells).filter(c=>c.deployed&&c.skill===skill).length;}
export default App;

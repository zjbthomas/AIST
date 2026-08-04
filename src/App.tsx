import { useEffect, useMemo, useRef, useState } from "react";
import { pinyin } from "pinyin-pro";
import { Copy, Download, ExternalLink, FolderOpen, GripVertical, Library, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { fallbackOperators, type Operator, type OperatorForm } from "./data/operators";
import { squads as fallbackSquads, stages as fallbackStages, themes, type Stage } from "./data/stages";
import type { CellState, Elite, RunOperator, RunState, Skill, TimelineNode, TrackerStore } from "./types";

const STORAGE_KEY = "arknights-is-tracker:v2";
const rarityColor: Record<number, string> = { 6: "#f59e0b", 5: "#facc15", 4: "#a855f7", 3: "#1d4ed8", 2: "#22c55e", 1: "#9ca3af" };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;

const PROFESSIONS = [
  { id: "VANGUARD", label: "先锋" },
  { id: "GUARD", label: "近卫" },
  { id: "DEFENDER", label: "重装" },
  { id: "SNIPER", label: "狙击" },
  { id: "CASTER", label: "术师" },
  { id: "MEDIC", label: "医疗" },
  { id: "SUPPORTER", label: "辅助" },
  { id: "SPECIALIST", label: "特种" },
 ] as const;

const PROFESSION_ALIASES: Record<string, string> = {
  PIONEER: "VANGUARD", VANGUARD: "VANGUARD", 先锋: "VANGUARD",
  WARRIOR: "GUARD", GUARD: "GUARD", 近卫: "GUARD",
  TANK: "DEFENDER", DEFENDER: "DEFENDER", 重装: "DEFENDER",
  SNIPER: "SNIPER", 狙击: "SNIPER",
  CASTER: "CASTER", 术师: "CASTER",
  MEDIC: "MEDIC", 医疗: "MEDIC",
  SUPPORT: "SUPPORTER", SUPPORTER: "SUPPORTER", 辅助: "SUPPORTER",
  SPECIAL: "SPECIALIST", SPECIALIST: "SPECIALIST", 特种: "SPECIALIST",
};
const normalizeProfession = (value?: string) => PROFESSION_ALIASES[String(value ?? "").trim()] ?? PROFESSION_ALIASES[String(value ?? "").trim().toUpperCase()] ?? String(value ?? "").trim().toUpperCase();

function amiyaFormLabel(profession?: string) {
  const normalized = normalizeProfession(profession);
  return PROFESSIONS.find((item) => item.id === normalized)?.label ?? "未知形态";
}

function mergeSpecialOperators(source: Operator[]): Operator[] {
  const amiya = source.filter((op) => /^阿米娅(?:$|[（(])/.test(op.name));
  const others = source.filter((op) => !/^阿米娅(?:$|[（(])/.test(op.name));
  if (!amiya.length) return source;
  const forms: OperatorForm[] = amiya.map((op) => ({
    id: op.id,
    name: amiyaFormLabel(op.profession),
    profession: normalizeProfession(op.profession),
    avatar: op.avatar,
    skills: op.skills,
    prtsUrl: op.prtsUrl,
  })).sort((a,b)=>["CASTER","MEDIC","GUARD"].indexOf(a.profession ?? "")-["CASTER","MEDIC","GUARD"].indexOf(b.profession ?? ""));
  const base = amiya.find((op) => normalizeProfession(op.profession) === "CASTER") ?? amiya[0];
  const merged: Operator = { ...base, id: "阿米娅", name: "阿米娅", profession: forms[0]?.profession ?? base.profession, avatar: forms[0]?.avatar ?? base.avatar, skills: forms[0]?.skills ?? base.skills, prtsUrl: base.prtsUrl, forms };
  return [...others, merged];
}

function operatorForForm(operator: Operator, formId?: string): Operator {
  const form = operator.forms?.find((item) => item.id === formId) ?? operator.forms?.[0];
  return form ? { ...operator, id: `${operator.id}::${form.id}`, name: `${operator.name}（${form.name}）`, profession: form.profession, avatar: form.avatar, skills: form.skills, prtsUrl: form.prtsUrl, forms: undefined } : operator;
}

function operatorSearchText(operator: Operator) {
  const full = pinyin(operator.name, { toneType: "none", type: "array" }).join("");
  const spaced = pinyin(operator.name, { toneType: "none", type: "array" }).join(" ");
  const initials = pinyin(operator.name, { pattern: "first", toneType: "none", type: "array" }).join("");
  return `${operator.name} ${full} ${spaced} ${initials}`.toLowerCase();
}

type PresetSummary = {
  id: string;
  name: string;
  description?: string;
  theme: string;
  squad?: string;
  author?: string;
  event?: string;
  date?: string;
  tags?: string[];
  file: string;
};

type LoadedPreset = PresetSummary & { run: RunState };

type NodeTypeOption = {
  id: string;
  theme: string;
  code?: string;
  name: string;
  kind: "combat" | "other";
};

const FALLBACK_OTHER_NODE_TYPES: Omit<NodeTypeOption, "theme">[] = [
  { id: "encounter", code: "ENCOUNTER", name: "不期而遇", kind: "other" },
  { id: "wish", code: "WISH", name: "得偿所愿", kind: "other" },
  { id: "safe-house", code: "SAFE HOUSE", name: "安全屋", kind: "other" },
  { id: "downtime-recreation", code: "DOWNTIME RECREATION", name: "幕间余兴", kind: "other" },
  { id: "rogue-trader", code: "ROGUE TRADER", name: "诡意行商", kind: "other" },
  { id: "enter-new-floor", code: "ENTER NEW FLOOR", name: "（进入新一层）", kind: "other" },
];

function cloneRun(source: RunState, suffix = " - 副本"): RunState {
  const cloned = structuredClone(source);
  const createdAt = now();
  return { ...cloned, id: uid(), name: `${source.name}${suffix}`, createdAt, updatedAt: createdAt };
}

function migrateSpecialRun(run: RunState): RunState {
  const amiyaRows=run.operators.filter((row)=>/^阿米娅(?:$|[（(])/.test(row.operatorId));
  if (amiyaRows.length<=1 || (amiyaRows.length===1&&amiyaRows[0].operatorId==="阿米娅")) return run;
  const cells:Record<string,CellState>={};
  for (const row of amiyaRows) {
    for (const [nodeId,cell] of Object.entries(row.cells)) {
      cells[nodeId]={...cells[nodeId],...cell,formId:cell.formId??row.operatorId};
    }
  }
  return {...run,operators:[...run.operators.filter((row)=>!/^阿米娅(?:$|[（(])/.test(row.operatorId)),{operatorId:"阿米娅",cells}]};
}

function createRun(name = `新记录 ${new Date().toLocaleString("zh-CN")}`): RunState {
  return {
    id: uid(), name, theme: themes[0], squad: fallbackSquads[0], createdAt: now(), updatedAt: now(),
    nodes: [{ id: uid(), floor: 0, type: "initial", name: "初始招募 / 分队" }], operators: [],
  };
}

function loadStore(): TrackerStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as TrackerStore | null;
    if (parsed?.schemaVersion === 2 && parsed.runs.length) return { ...parsed, runs: parsed.runs.map(migrateSpecialRun) };
  } catch { /* ignore damaged local data */ }
  const run = createRun();
  return { schemaVersion: 2, activeRunId: run.id, runs: [run] };
}

function App() {
  const [store, setStore] = useState<TrackerStore>(loadStore);
  const [operators, setOperators] = useState<Operator[]>(mergeSpecialOperators(fallbackOperators));
  const [stages, setStages] = useState<Stage[]>(fallbackStages);
  const [squads, setSquads] = useState<{ id: string; theme: string; name: string }[]>(themes.flatMap((theme) => fallbackSquads.map((name) => ({ id: `${theme}|${name}`, theme, name }))));
  const [nodeTypes, setNodeTypes] = useState<NodeTypeOption[]>(themes.flatMap((theme) => FALLBACK_OTHER_NODE_TYPES.map((item) => ({ ...item, theme, id: `${theme}|${item.id}` }))));
  const [dataStatus, setDataStatus] = useState("正在检查 PRTS 数据…");
  const [showOperatorPicker, setShowOperatorPicker] = useState(false);
  const [showStagePicker, setShowStagePicker] = useState(false);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [customNodeFloor, setCustomNodeFloor] = useState(1);
  const [customNodeTypeId, setCustomNodeTypeId] = useState("custom");
  const [customNodeName, setCustomNodeName] = useState("不期而遇");
  const [stageCategory, setStageCategory] = useState<string>("all");
  const [stageFloor, setStageFloor] = useState<number>(1);
  const [showRunManager, setShowRunManager] = useState(false);
  const [showPresetLibrary, setShowPresetLibrary] = useState(false);
  const [presets, setPresets] = useState<LoadedPreset[]>([]);
  const [presetStatus, setPresetStatus] = useState("正在读取预设记录…");
  const [previewPresetId, setPreviewPresetId] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<{ operatorId: string; nodeId: string } | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [operatorRarity, setOperatorRarity] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(0);
  const [operatorProfession, setOperatorProfession] = useState<string>("all");
  const [operatorAvailability, setOperatorAvailability] = useState<"all" | "available" | "added">("available");
  const [operatorPickerSort, setOperatorPickerSort] = useState<"rarity-desc" | "rarity-asc" | "name-asc">("rarity-desc");
  const [sortBy, setSortBy] = useState<"recruit" | "rarity" | "deploy">("recruit");
  const [simplifiedTimeline, setSimplifiedTimeline] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const draggedOperatorId = useRef<string | null>(null);
  const draggedNodeId = useRef<string | null>(null);

  const localRun = store.runs.find((item) => item.id === store.activeRunId) ?? store.runs[0];
  const previewPreset = presets.find((item) => item.id === previewPresetId);
  const run = previewPreset?.run ?? localRun;
  const isPresetPreview = Boolean(previewPreset);
  const hasTimelineData = run.operators.length > 0 || run.nodes.some((node) => node.type !== "initial");
  const currentOtherNodeTypes = useMemo(() => {
    const synced = nodeTypes.filter((item) => item.theme === run.theme && item.kind === "other");
    const fallback = FALLBACK_OTHER_NODE_TYPES.map((item) => ({ ...item, theme: run.theme, id: `${run.theme}|${item.id}` }));
    // “进入新一层”不是 PRTS 节点，而是记录器提供的固定时间轴节点。
    // 即使同步数据存在，也始终把它补进当前主题的其它节点列表。
    const source = synced.length ? [...synced, ...fallback.filter((item) => item.id.endsWith("|enter-new-floor"))] : fallback;
    return source.filter((item, index) => source.findIndex((candidate) => candidate.name === item.name) === index);
  }, [nodeTypes, run.theme]);

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store)), [store]);
  useEffect(() => { setStageCategory("all"); setStageFloor(1); }, [run.theme]);
  useEffect(() => {
    const first = currentOtherNodeTypes[0];
    if (first) {
      setCustomNodeTypeId(first.id);
      setCustomNodeName(first.name);
    }
  }, [run.theme, nodeTypes]);
  useEffect(() => {
    Promise.all([
      fetch(asset("data/operators.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : Promise.reject()),
      fetch(asset("data/stages.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : Promise.reject()),
      fetch(asset("data/squads.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : []),
      fetch(asset("data/node-types.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : []),
      fetch(asset("data/manifest.json"), { cache: "no-cache" }).then((r) => r.ok ? r.json() : null),
    ]).then(([opData, stageData, squadData, nodeTypeData, manifest]) => {
      if (Array.isArray(opData) && opData.length) setOperators(mergeSpecialOperators(opData.map((op: Operator) => ({ ...op, profession: normalizeProfession(op.profession) }))));
      if (Array.isArray(stageData) && stageData.length) setStages(stageData.map((stage: Stage & { battleType?: string }) => ({
        ...stage,
        sectionCode: stage.sectionCode ?? "LEGACY",
        sectionName: stage.sectionName ?? "旧版作战",
        categoryId: stage.categoryId ?? `LEGACY:${stage.battleType ?? "normal"}`,
        categoryName: stage.categoryName ?? ({ normal: "一般作战", emergency: "紧急作战", boss: "险路恶敌", special: "特殊作战" }[stage.battleType ?? "normal"] ?? "旧版作战"),
        variant: stage.variant ?? stage.battleType ?? "default",
      })));
      if (Array.isArray(squadData) && squadData.length) setSquads(squadData);
      if (Array.isArray(nodeTypeData) && nodeTypeData.length) setNodeTypes(nodeTypeData);
      setDataStatus(manifest?.updatedAt ? `PRTS 数据：${new Date(manifest.updatedAt).toLocaleString("zh-CN")}` : "已加载本地 PRTS 数据");
    }).catch(() => setDataStatus("使用内置数据；下次启动会再次检查"));
  }, []);

  useEffect(() => {
    fetch(asset("presets/index.json"), { cache: "no-cache" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("找不到预设索引")))
      .then(async (index: PresetSummary[]) => {
        if (!Array.isArray(index)) throw new Error("预设索引格式错误");
        const loaded: LoadedPreset[] = [];
        for (const item of index) {
          try {
            const response = await fetch(asset(`presets/${item.file}`), { cache: "no-cache" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const parsed = await response.json() as RunState | TrackerStore;
            const run = "runs" in parsed ? parsed.runs[0] : parsed;
            if (!run?.id || !Array.isArray(run.nodes) || !Array.isArray(run.operators)) throw new Error("记录格式错误");
            loaded.push({ ...item, run: migrateSpecialRun(run) });
          } catch (error) {
            console.warn(`无法加载预设 ${item.name}:`, error);
          }
        }
        setPresets(loaded);
        setPresetStatus(index.length ? `已加载 ${loaded.length}/${index.length} 个预设` : "暂未配置预设记录");
      })
      .catch(() => setPresetStatus("暂未配置预设记录"));
  }, []);

  const operatorMap = useMemo(() => Object.fromEntries(operators.map((op) => [op.id, op])), [operators]);
  const availableSquads = useMemo(() => squads.filter((item) => item.theme === run.theme), [squads, run.theme]);
  const pickerOperators = useMemo(() => {
    const added = new Set(run.operators.map((row) => row.operatorId));
    const rows = operators.filter((op) => {
      const normalizedSearch = search.trim().toLowerCase().replace(/\s+/g, "");
      if (normalizedSearch && !operatorSearchText(op).replace(/\s+/g, "").includes(normalizedSearch)) return false;
      if (operatorProfession !== "all" && normalizeProfession(op.profession) !== operatorProfession) return false;
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
  }, [operators, run.operators, search, operatorProfession, operatorRarity, operatorAvailability, operatorPickerSort]);
  const stageCategories = useMemo(() => {
    const map = new Map<string, { id: string; name: string; sectionCode: string; sectionName: string; count: number }>();
    for (const stage of stages.filter((item) => item.theme === run.theme)) {
      const existing = map.get(stage.categoryId);
      if (existing) existing.count += 1;
      else map.set(stage.categoryId, { id: stage.categoryId, name: stage.categoryName, sectionCode: stage.sectionCode, sectionName: stage.sectionName, count: 1 });
    }
    return [...map.values()];
  }, [stages, run.theme]);
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
      if (last && last.floor === node.floor) last.count++;
      else groups.push({ floor: node.floor, count: 1 });
    }
    return groups;
  }, [run.nodes]);

  function updateRun(updater: (current: RunState) => RunState) {
    if (isPresetPreview) return;
    setStore((prev) => ({ ...prev, runs: prev.runs.map((item) => item.id === localRun.id ? { ...updater(item), updatedAt: now() } : item) }));
  }
  function addOperator(op: Operator) {
    if (run.operators.some((row) => row.operatorId === op.id)) return;
    updateRun((current) => {
      const recruitNode = current.nodes.at(-1) ?? current.nodes[0];
      const cells = recruitNode ? { [recruitNode.id]: { recruitType: "normal" as const, elite: 1 as const } } : {};
      return { ...current, operators: [...current.operators, { operatorId: op.id, cells }] };
    });
    setShowOperatorPicker(false);
  }
  function addStage(stageId: string) {
    const stage = stages.find((item) => item.id === stageId); if (!stage) return;
    const floor = stage.floor || stageFloor;
    updateRun((current) => {
      const node = {
        id: uid(), floor, type: "combat" as const, stageId: stage.id,
        categoryId: stage.categoryId, categoryName: stage.categoryName,
        sectionCode: stage.sectionCode, sectionName: stage.sectionName,
        name: stage.name,
      };
      const next = [...current.nodes];
      let insertAt = next.length;
      for (let i = 1; i < next.length; i++) if (next[i].floor > floor) { insertAt = i; break; }
      next.splice(insertAt, 0, node);

      // Inherit the setup from the nearest earlier combat node, skipping any
      // event/shop/encounter nodes between it and the newly added battle.
      // Recruitment and promotion are one-time events and are never copied.
      const previousCombatNode = [...next.slice(0, insertAt)]
        .reverse()
        .find((candidate) => candidate.type === "combat");
      const operators = current.operators.map((row) => {
        if (!previousCombatNode) return row;
        const previous = row.cells[previousCombatNode.id] ?? {};
        const inherited: CellState = previous.deployed
          ? { deployed: true, skill: previous.skill, formId: previous.formId }
          : {};
        return Object.keys(inherited).length
          ? { ...row, cells: { ...row.cells, [node.id]: inherited } }
          : row;
      });

      return { ...current, nodes: next, operators };
    });
    setShowStagePicker(false);
  }

  function addCustomNode() {
    const selected = customNodeTypeId === "custom" ? undefined : currentOtherNodeTypes.find((item) => item.id === customNodeTypeId);
    const defaultName = selected?.name ?? "其它节点";
    const name = customNodeName.trim() || defaultName;
    const normalizedName = name === "商店" ? "诡意行商" : name;
    const timelineType: TimelineNode["type"] = /诡意行商/.test(normalizedName)
      ? "shop"
      : /不期而遇/.test(normalizedName)
        ? "encounter"
        : "event";
    updateRun((current) => {
      const node: TimelineNode = {
        id: uid(), floor: customNodeFloor, type: timelineType, name: normalizedName,
        categoryId: selected?.id, categoryName: selected?.name,
        sectionCode: selected?.code, sectionName: "事件节点",
      };
      const next = [...current.nodes];
      let insertAt = next.length;
      for (let i = 1; i < next.length; i++) if (next[i].floor > customNodeFloor) { insertAt = i; break; }
      next.splice(insertAt, 0, node);
      // Non-combat nodes intentionally do not carry any operator state.
      return { ...current, nodes: next };
    });
    setShowNodePicker(false);
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

  function moveOperatorRow(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    updateRun((current) => {
      const rows = [...current.operators];
      const from = rows.findIndex((row) => row.operatorId === sourceId);
      const to = rows.findIndex((row) => row.operatorId === targetId);
      if (from < 0 || to < 0) return current;
      const [moved] = rows.splice(from, 1);
      rows.splice(to, 0, moved);
      return { ...current, operators: rows };
    });
  }

  function moveCellState(operatorId: string, sourceNodeId: string, targetNodeId: string) {
    if (sourceNodeId === targetNodeId) return;
    updateRun((current) => ({
      ...current,
      operators: current.operators.map((row) => {
        if (row.operatorId !== operatorId || row.cells[targetNodeId]) return row;
        const source = row.cells[sourceNodeId];
        if (!source) return row;
        const cells = { ...row.cells, [targetNodeId]: source };
        delete cells[sourceNodeId];
        return { ...row, cells };
      }),
    }));
  }

  function moveNode(sourceNodeId: string, targetNodeId: string) {
    if (sourceNodeId === targetNodeId) return;
    updateRun((current) => {
      const nodes = [...current.nodes];
      const from = nodes.findIndex((node) => node.id === sourceNodeId);
      const to = nodes.findIndex((node) => node.id === targetNodeId);
      if (from <= 0 || to <= 0) return current;
      const [moved] = nodes.splice(from, 1);
      nodes.splice(to, 0, moved);
      return { ...current, nodes };
    });
  }

  function updateTimelineNode(nodeId: string, replacement: TimelineNode) {
    updateRun((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...replacement, id: nodeId } : node),
    }));
    setEditingNodeId(null);
  }

  function clearOperatorsAndStages() {
    if (isPresetPreview || !hasTimelineData) return;
    if (!window.confirm("确定清除当前记录中已添加的全部干员和关卡吗？此操作不会删除记录名称、主题和分队。")) return;
    updateRun((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.type === "initial"),
      operators: [],
    }));
    setEditingCell(null);
  }

  function exportStore() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `arknights-is-records-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  }
  function importStore(file: File) {
    file.text().then((text) => {
      const parsed = JSON.parse(text) as TrackerStore;
      if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.runs)) throw new Error("格式不正确");
      setStore({ ...parsed, runs: parsed.runs.map(migrateSpecialRun) }); setShowRunManager(false);
    }).catch((error) => alert(`读取失败：${error.message}`));
  }
  function copyPreset(preset: LoadedPreset) {
    const copied = cloneRun(preset.run);
    setStore((current) => ({ ...current, activeRunId: copied.id, runs: [...current.runs, copied] }));
    setPreviewPresetId(null);
    setShowPresetLibrary(false);
  }

  return <div className="app-shell">
    <header className="topbar">
      <div><div className="eyebrow">ARKNIGHTS ROGUELIKE</div><h1>集成战略记录器</h1><div className="data-status">{dataStatus}</div></div>
      <div className="top-actions">
        <button className="ghost-button" onClick={() => setShowRunManager(true)}><FolderOpen size={16}/> 记录</button>
        <button className="ghost-button" onClick={() => setShowPresetLibrary(true)}><Library size={16}/> 预设</button>
        <button className="ghost-button" onClick={exportStore}><Download size={16}/> 导出</button>
        <button className="ghost-button" onClick={() => importRef.current?.click()}><Upload size={16}/> 导入</button>
        <input ref={importRef} hidden type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importStore(e.target.files[0])}/>
      </div>
    </header>

    {isPresetPreview&&previewPreset&&<section className="preset-preview-banner panel"><div><strong>只读预设：{previewPreset.name}</strong><span>{previewPreset.description || "此记录来自网站预设，不会修改你的本地数据。"}</span></div><div className="top-actions"><button onClick={()=>copyPreset(previewPreset)}><Copy size={16}/> 复制到我的记录</button><button className="ghost-button" onClick={()=>setPreviewPresetId(null)}>退出预览</button></div></section>}

    <section className="toolbar panel">
      <label>记录名称<input disabled={isPresetPreview} value={run.name} onChange={(e) => updateRun((r) => ({ ...r, name: e.target.value }))}/></label>
      <label>集成战略<select disabled={isPresetPreview || hasTimelineData} title={hasTimelineData ? "已有干员或关卡时不能更改集成战略；请先一键清除" : undefined} value={run.theme} onChange={(e) => { const theme = e.target.value; const firstSquad = squads.find((item) => item.theme === theme)?.name ?? fallbackSquads[0]; updateRun((r) => ({ ...r, theme, squad: firstSquad })); }}>{themes.map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>分队<select disabled={isPresetPreview} value={run.squad} onChange={(e) => updateRun((r) => ({ ...r, squad: e.target.value }))}>{availableSquads.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</select></label>
      <label>行排序<select disabled={simplifiedTimeline} value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}><option value="recruit">添加顺序</option><option value="rarity">星级降序</option><option value="deploy">编队次数</option></select></label>
      <label className="timeline-view-toggle"><span>时间线视图</span><span className="check-row"><input type="checkbox" checked={simplifiedTimeline} onChange={(e)=>setSimplifiedTimeline(e.target.checked)}/><span>仅显示招募</span></span></label>
      <div className="toolbar-actions"><button disabled={isPresetPreview} onClick={() => setShowOperatorPicker(true)}><Plus size={16}/> 添加干员</button><button disabled={isPresetPreview} onClick={() => setShowStagePicker(true)}><Plus size={16}/> 添加关卡</button><button disabled={isPresetPreview} onClick={() => setShowNodePicker(true)}><Plus size={16}/> 添加其它节点</button><button className="danger-button" disabled={isPresetPreview || !hasTimelineData} onClick={clearOperatorsAndStages}><Trash2 size={16}/> 一键清除干员和关卡</button></div>
    </section>

    <section className="timeline-panel panel"><div className="timeline-scroll"><div className="timeline-grid" style={{gridTemplateColumns:`210px repeat(${run.nodes.length}, 122px)`}}>
      <div className="corner floor-header sticky-left">干员 / 楼层</div>
      {floorGroups.map((g,i)=><div key={`${g.floor}-${i}`} className="floor-header" style={{gridColumn:`span ${g.count}`}}>{g.floor===0?"初始":`第 ${g.floor} 层`}</div>)}
      <div className="corner node-header sticky-left">节点</div>
      {run.nodes.map((node) => (
        <div
          className={`node-header ${node.type !== "initial" && !isPresetPreview ? "node-draggable" : ""}`}
          key={node.id}
          draggable={node.type !== "initial" && !isPresetPreview}
          onDragStart={(event) => {
            if (node.type === "initial" || isPresetPreview) return;
            draggedNodeId.current = node.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-aist-node", node.id);
            event.dataTransfer.setData("text/plain", `node:${node.id}`);
          }}
          onDragOver={(event) => {
            if (node.type !== "initial" && event.dataTransfer.types.includes("application/x-aist-node")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            if (node.type === "initial" || isPresetPreview) return;
            const source = event.dataTransfer.getData("application/x-aist-node") || draggedNodeId.current;
            if (source) {
              event.preventDefault();
              moveNode(source, node.id);
            }
            draggedNodeId.current = null;
          }}
        >
          <div className="node-title">{node.name}</div>
          {node.type === "combat"
            ? <span className="battle-type-badge">{node.categoryName ?? stages.find((stage) => stage.id === node.stageId)?.categoryName ?? "作战"}</span>
            : node.type !== "initial"
              ? <span className="battle-type-badge node-type-badge">{node.categoryName ?? node.name}</span>
              : null}
          <div className="node-actions">
            {node.stageId && <a href={stages.find((stage) => stage.id === node.stageId)?.prtsUrl} target="_blank" rel="noreferrer"><ExternalLink size={14}/></a>}
            {node.type !== "initial" && !isPresetPreview && (
              <span className="node-edit-actions">
                <button onClick={() => setEditingNodeId(node.id)} title="修改节点"><Pencil size={14}/></button>
                <button onClick={() => removeNode(node.id)} title="删除节点"><Trash2 size={14}/></button>
              </span>
            )}
          </div>
        </div>
      ))}
      {simplifiedTimeline ? <>
        <div className="operator-label sticky-left simplified-row-label"><strong>本节点招募</strong><span>按节点纵向显示</span></div>
        {run.nodes.map((node,nodeIndex)=>{
          const recruited=run.operators.flatMap((row)=>{
            const state=row.cells[node.id];
            const operator=operatorMap[row.operatorId];
            if(!state?.recruitType||!operator)return [];
            const formId=resolveEffectiveFormId(operator,row,run.nodes,nodeIndex);
            return [{row,state,operator:operatorForForm(operator,formId)}];
          });
          return <div key={`simple-${node.id}`} className="simplified-recruit-cell">
            {recruited.length?recruited.map(({row,state,operator})=><button key={row.operatorId} className="simplified-recruit-avatar" title={`${operator.name} · ${state.recruitType==="temporary"?"临时招募":"普通招募"}`} onClick={()=>{if(!isPresetPreview)setEditingCell({operatorId:row.operatorId,nodeId:node.id});}}>
              <OperatorAvatar operator={operator} state={state} recruitedHere size={54}/>
            </button>):<span className="simplified-empty">—</span>}
          </div>;
        })}
      </> : sortedRows.map((row)=>{const op=operatorMap[row.operatorId]; return op?<TimelineRow key={row.operatorId} row={row} operator={op} nodes={run.nodes} onRemove={()=>updateRun(r=>({...r,operators:r.operators.filter(x=>x.operatorId!==row.operatorId)}))} onEdit={(nodeId)=>{if(!isPresetPreview)setEditingCell({operatorId:row.operatorId,nodeId});}} readOnly={isPresetPreview} onRowDragStart={()=>{draggedOperatorId.current=row.operatorId;}} onRowDrop={()=>{if(draggedOperatorId.current)moveOperatorRow(draggedOperatorId.current,row.operatorId);draggedOperatorId.current=null;}} onMoveCell={(sourceNodeId,targetNodeId)=>moveCellState(row.operatorId,sourceNodeId,targetNodeId)}/>:null;})}
    </div></div></section>
    <Stats run={run} operatorMap={operatorMap}/>
    <AggregateStats store={store} presets={presets} operatorMap={operatorMap}/>

    {showOperatorPicker&&<Modal title="添加干员" onClose={()=>setShowOperatorPicker(false)}>
      <div className="profession-filter" aria-label="按职业筛选">
        <button className={operatorProfession === "all" ? "active" : ""} onClick={() => setOperatorProfession("all")}>全部</button>
        {PROFESSIONS.map((profession) => <button key={profession.id} className={operatorProfession === profession.id ? "active" : ""} onClick={() => setOperatorProfession(profession.id)}>{profession.label}</button>)}
      </div>
      <div className="picker-controls">
        <input autoFocus className="search-input" placeholder="搜索中文、拼音或首字母，例如：棘刺 / jici / jc" value={search} onChange={(e)=>setSearch(e.target.value)}/>
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
    {showStagePicker&&<Modal title="添加关卡" onClose={()=>setShowStagePicker(false)}>
      {stages.some(stage=>stage.theme===run.theme&&stage.floor===0)&&<div className="stage-floor-warning"><strong>部分关卡的楼层无法从 PRTS 自动识别。</strong><span>这些关卡会标记为“自选”，请使用下方楼层按钮指定它们所在的层数。</span></div>}
      <div className="stage-floor-filters" aria-label="选择楼层">{[1,2,3,4,5,6].map(floor=><button key={floor} className={stageFloor===floor?"active":""} onClick={()=>setStageFloor(floor)}>第 {floor} 层</button>)}</div>
      <div className="stage-type-filters">
        <button className={stageCategory==="all"?"active":""} onClick={()=>setStageCategory("all")}>全部类别</button>
        {stageCategories.map(category=><button key={category.id} className={stageCategory===category.id?"active":""} onClick={()=>setStageCategory(category.id)} title={`${category.sectionCode} · ${category.sectionName}`}>{category.name}<small>{category.count}</small></button>)}
      </div>
      <div className="stage-list">{stages
        .filter(s=>s.theme===run.theme&&(stageCategory==="all"||s.categoryId===stageCategory)&&(s.floor===0||s.floor===stageFloor))
        .sort((a,b)=>a.categoryName.localeCompare(b.categoryName,"zh-CN")||a.name.localeCompare(b.name,"zh-CN"))
        .map(s=><button key={s.id} className="stage-item" onClick={()=>addStage(s.id)}><span>{s.floor?`第 ${s.floor} 层`:`第 ${stageFloor} 层（自选）`} · {s.categoryName}</span><strong>{s.name}</strong><small>{s.sectionCode} · {s.sectionName}</small></button>)}</div>
    </Modal>}
    {showNodePicker&&<Modal title="添加其它节点" onClose={()=>setShowNodePicker(false)}>
      <div className="editor-form">
        <div><div className="field-title">节点类型</div><div className="segmented node-kind-options">{currentOtherNodeTypes.map((item)=><button key={item.id} className={customNodeTypeId===item.id?'active':''} onClick={()=>{setCustomNodeTypeId(item.id);setCustomNodeName(item.name);}}>{item.name}</button>)}<button className={customNodeTypeId==='custom'?'active':''} onClick={()=>{setCustomNodeTypeId('custom');setCustomNodeName('自定义节点');}}>自定义节点</button></div></div>
        <label>节点名称<input value={customNodeName} onChange={(e)=>setCustomNodeName(e.target.value)} /></label>
        <div><div className="field-title">所在楼层</div><div className="stage-floor-filters">{[1,2,3,4,5,6].map(floor=><button key={floor} className={customNodeFloor===floor?'active':''} onClick={()=>setCustomNodeFloor(floor)}>第 {floor} 层</button>)}</div></div>
        <button className="wide-button" onClick={addCustomNode}><Plus size={16}/> 添加节点</button>
      </div>
    </Modal>}

    {editingNodeId&&<NodeEditor node={run.nodes.find((node)=>node.id===editingNodeId)!} stages={stages.filter((stage)=>stage.theme===run.theme)} otherNodeTypes={currentOtherNodeTypes} onSave={(node)=>updateTimelineNode(editingNodeId,node)} onClose={()=>setEditingNodeId(null)}/>}
    {editingCell&&<CellEditor operator={operatorMap[editingCell.operatorId]} node={run.nodes.find(n=>n.id===editingCell.nodeId)!} row={run.operators.find(r=>r.operatorId===editingCell.operatorId)!} nodes={run.nodes} onChange={(patch)=>updateCell(editingCell.operatorId,editingCell.nodeId,patch)} onClose={()=>setEditingCell(null)}/>} 
    {showPresetLibrary&&<PresetLibrary presets={presets} status={presetStatus} onClose={()=>setShowPresetLibrary(false)} onPreview={(id)=>{setPreviewPresetId(id);setShowPresetLibrary(false);}} onCopy={copyPreset}/>}
    {showRunManager&&<RunManager store={store} onClose={()=>setShowRunManager(false)} onSelect={(id)=>{setPreviewPresetId(null);setStore(s=>({...s,activeRunId:id}));}} onCreate={()=>{const newRun=createRun();setStore(s=>({...s,activeRunId:newRun.id,runs:[...s.runs,newRun]}));}} onDelete={(id)=>setStore(s=>{if(s.runs.length===1)return s;const runs=s.runs.filter(r=>r.id!==id);return{...s,runs,activeRunId:s.activeRunId===id?runs[0].id:s.activeRunId};})}/>} 
  </div>;
}

function TimelineRow({row,operator,nodes,onRemove,onEdit,readOnly=false,onRowDragStart,onRowDrop,onMoveCell}:{row:RunOperator;operator:Operator;nodes:TimelineNode[];onRemove:()=>void;onEdit:(id:string)=>void;readOnly?:boolean;onRowDragStart:()=>void;onRowDrop:()=>void;onMoveCell:(sourceNodeId:string,targetNodeId:string)=>void}) {
  return <><div className="operator-label sticky-left" onDragOver={(event)=>{if(event.dataTransfer.types.includes("application/x-aist-row"))event.preventDefault();}} onDrop={(event)=>{if(event.dataTransfer.types.includes("application/x-aist-row")){event.preventDefault();onRowDrop();}}}><span className="row-drag-handle" draggable={!readOnly} onDragStart={(event)=>{event.stopPropagation();event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("application/x-aist-row",operator.id);event.dataTransfer.setData("text/plain",`row:${operator.id}`);onRowDragStart();}} title="拖动调整干员行顺序"><GripVertical size={18}/></span><OperatorAvatar operator={operator} size={50}/><div className="operator-text"><span>{operator.name}</span><span>{operator.rarity}★ · 编队 {countDeploys(row)} · 部署 {countUses(row)}</span></div><a className="operator-prts-link" href={operator.prtsUrl} target="_blank" rel="noreferrer" title="在 PRTS 查看干员"><ExternalLink size={15}/></a>{!readOnly&&<button onClick={onRemove}><X size={15}/></button>}</div>{nodes.map((node,index)=>{const state=row.cells[node.id]??{};const hasState=Object.keys(state).length>0;const recruitedIndex=nodes.findIndex(n=>Boolean(row.cells[n.id]?.recruitType));const owned=recruitedIndex>=0&&index>=recruitedIndex;const effective=resolveEffectiveState(row,nodes,index);return <button key={node.id} className={`timeline-cell ${owned?"owned":""} ${readOnly?"readonly":""}`} draggable={!readOnly&&hasState} onDragStart={(event)=>{if(!hasState)return;event.stopPropagation();event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("application/x-aist-cell",JSON.stringify({operatorId:operator.id,nodeId:node.id}));event.dataTransfer.setData("text/plain",JSON.stringify({operatorId:operator.id,nodeId:node.id}));}} onDragOver={(event)=>{if(!readOnly&&!hasState&&event.dataTransfer.types.includes("application/x-aist-cell")){event.preventDefault();event.dataTransfer.dropEffect="move";}}} onDrop={(event)=>{if(readOnly||hasState)return;const raw=event.dataTransfer.getData("application/x-aist-cell")||event.dataTransfer.getData("text/plain");if(!raw||raw.startsWith("row:"))return;event.preventDefault();event.stopPropagation();try{const payload=JSON.parse(raw);if(payload.operatorId===operator.id)onMoveCell(payload.nodeId,node.id);}catch{}}} onClick={()=>onEdit(node.id)}>{owned&&<span className="connector"/>}{(state.recruitType||state.deployed)&&<OperatorAvatar operator={operatorForForm(operator, resolveEffectiveFormId(operator,row,nodes,index))} state={{...state,elite:effective.elite,recruitType:effective.recruitType}} recruitedHere={Boolean(state.recruitType)} usedHere={Boolean(state.used)} size={68}/>} {state.promotionAfter===2&&<span className="promotion-after" title="此节点后晋升精英化二"><span>→</span><img src={asset("icons/elite-2.svg")} alt="节点后晋升精英化二"/></span>}</button>;})}</>;
}

function OperatorAvatar({operator,state,size=58,recruitedHere=false,usedHere=false}:{operator:Operator;state?:CellState;size?:number;recruitedHere?:boolean;usedHere?:boolean}) {
  const temporary=state?.recruitType==="temporary"; const skill=state?.skill ? operator.skills.find(s=>s.index===state.skill) : undefined;
  return <div className="avatar-ring" style={{width:size,height:size,background:temporary?`conic-gradient(#7dd3fc 0deg 180deg, ${rarityColor[operator.rarity]} 180deg 360deg)`:rarityColor[operator.rarity]}} title={`${operator.name} · ${operator.rarity}星`}><img src={operator.avatar || asset("icons/operator-fallback.svg")} alt={operator.name} onError={(e)=>{e.currentTarget.onerror=null;e.currentTarget.src=asset("icons/operator-fallback.svg");}}/>{state?.elite&&<img className="image-badge elite-image" src={asset(`icons/elite-${state.elite}.svg`)} alt={`精英化${state.elite}`}/>} {state?.deployed&&state.skill&&<img className="image-badge skill-image" src={skill?.icon||asset("icons/skill-fallback.svg")} alt={skill?.name||`技能${state.skill}`} title={skill?.name||`技能 ${state.skill}`} onError={(e)=>{e.currentTarget.src=asset("icons/skill-fallback.svg");}}/>}{recruitedHere?<span className="recruit-badge">+</span>:usedHere?<span className="used-badge" title="本关部署">✓</span>:null}</div>;
}


function NodeEditor({node,stages,otherNodeTypes,onSave,onClose}:{node:TimelineNode;stages:Stage[];otherNodeTypes:NodeTypeOption[];onSave:(node:TimelineNode)=>void;onClose:()=>void}) {
  const [kind,setKind]=useState<"combat"|"other">(node.type==="combat"?"combat":"other");
  const [floor,setFloor]=useState(node.floor||1);
  const [stageId,setStageId]=useState(node.stageId??"");
  const [otherTypeId,setOtherTypeId]=useState(node.categoryId??"custom");
  const [name,setName]=useState(node.name);
  const availableStages=stages.filter((stage)=>stage.floor===0||stage.floor===floor);
  function save(){
    if(kind==="combat"){
      const stage=stages.find((item)=>item.id===stageId);
      if(!stage){window.alert("请选择一个作战关卡");return;}
      onSave({id:node.id,floor:stage.floor||floor,type:"combat",stageId:stage.id,categoryId:stage.categoryId,categoryName:stage.categoryName,sectionCode:stage.sectionCode,sectionName:stage.sectionName,name:stage.name});
      return;
    }
    const selected=otherNodeTypes.find((item)=>item.id===otherTypeId);
    const finalName=(name.trim()||selected?.name||"其它节点").replace(/^商店$/,"诡意行商");
    const type:TimelineNode["type"]=/诡意行商/.test(finalName)?"shop":/不期而遇/.test(finalName)?"encounter":"event";
    onSave({id:node.id,floor,type,name:finalName,categoryId:selected?.id,categoryName:selected?.name,sectionCode:selected?.code,sectionName:"事件节点"});
  }
  return <Modal title="修改节点" onClose={onClose}><div className="editor-form">
    <div><div className="field-title">节点类别</div><div className="segmented"><button className={kind==="combat"?"active":""} onClick={()=>setKind("combat")}>作战节点</button><button className={kind==="other"?"active":""} onClick={()=>setKind("other")}>其它节点</button></div></div>
    <div><div className="field-title">所在楼层</div><div className="stage-floor-filters">{[1,2,3,4,5,6].map((value)=><button key={value} className={floor===value?"active":""} onClick={()=>setFloor(value)}>第 {value} 层</button>)}</div></div>
    {kind==="combat"?<><label>选择关卡<select value={stageId} onChange={(event)=>setStageId(event.target.value)}><option value="">请选择</option>{availableStages.sort((a,b)=>a.categoryName.localeCompare(b.categoryName,"zh-CN")||a.name.localeCompare(b.name,"zh-CN")).map((stage)=><option key={stage.id} value={stage.id}>{stage.categoryName} · {stage.name}</option>)}</select></label></>:<><div><div className="field-title">节点类型</div><div className="segmented node-kind-options">{otherNodeTypes.map((item)=><button key={item.id} className={otherTypeId===item.id?"active":""} onClick={()=>{setOtherTypeId(item.id);setName(item.name);}}>{item.name}</button>)}<button className={otherTypeId==="custom"?"active":""} onClick={()=>setOtherTypeId("custom")}>自定义节点</button></div></div><label>节点名称<input value={name} onChange={(event)=>setName(event.target.value)}/></label></>}
    <button className="wide-button" onClick={save}>保存修改</button>
  </div></Modal>;
}

function CellEditor({operator,node,row,nodes,onChange,onClose}:{operator:Operator;node:TimelineNode;row:RunOperator;nodes:TimelineNode[];onChange:(p:Partial<CellState>)=>void;onClose:()=>void}) {
  const index=nodes.findIndex(n=>n.id===node.id);
  const state=row.cells[node.id]??{};
  const recruitIndex=nodes.findIndex(n=>Boolean(row.cells[n.id]?.recruitType));
  const alreadyRecruited=recruitIndex>=0&&recruitIndex!==index;
  const effective=resolveEffectiveState(row,nodes,index);
  const effectiveFormId=resolveEffectiveFormId(operator,row,nodes,index);
  const activeOperator=operatorForForm(operator,state.formId ?? effectiveFormId);
  const availableSkills=[...activeOperator.skills].sort((a,b)=>a.index-b.index);
  const firstSkill=availableSkills[0]?.index;
  const isCombatNode=node.type==="combat";
  const canPromoteAfter=Boolean(effective.recruitType)&&effective.elite===1;
  return <Modal title={`${operator.name} · ${node.name}`} onClose={onClose}><div className="editor-form">
    <div><div className="field-title">招募方式（只能选择一次）</div><div className="segmented"><button disabled={alreadyRecruited} className={state.recruitType==="normal"?"active":""} onClick={()=>state.recruitType==="normal"?onChange({recruitType:undefined,elite:undefined,deployed:undefined,skill:undefined,promotionAfter:undefined}):onChange({recruitType:"normal",elite:state.elite??1})}>普通招募</button><button disabled={alreadyRecruited} className={state.recruitType==="temporary"?"active":""} onClick={()=>state.recruitType==="temporary"?onChange({recruitType:undefined,elite:undefined,deployed:undefined,skill:undefined,promotionAfter:undefined}):onChange({recruitType:"temporary",elite:state.elite??1})}>临时招募</button></div>{alreadyRecruited&&<p className="hint">该干员已经在更早的节点招募，不能再次招募。</p>}</div>
    {operator.forms?.length?<div><div className="field-title">当前形态</div><div className="segmented form-options">{operator.forms.map((form)=><button key={form.id} className={(state.formId ?? effectiveFormId)===form.id?"active":""} onClick={()=>{const next=operatorForForm(operator,form.id);onChange({formId:form.id,skill:state.deployed?next.skills[0]?.index:undefined});}}><img src={form.avatar||asset("icons/operator-fallback.svg")}/><span>{form.name}</span></button>)}</div><p className="hint">阿米娅只招募一次；每个节点可以选择当前使用的形态，技能会随形态切换。</p></div>:null}
    {state.recruitType&&<div><div className="field-title">招募时精英化状态</div><div className="segmented image-options"><button className={(state.elite??1)===1?"active":""} onClick={()=>onChange({elite:1})}><img src={asset("icons/elite-1.svg")}/><span>精英化一</span></button><button className={state.elite===2?"active":""} onClick={()=>onChange({elite:2,promotionAfter:undefined})}><img src={asset("icons/elite-2.svg")}/><span>直接精英化二</span></button></div><p className="hint">招募时可以直接获得精英化一或精英化二，不要求先精一再晋升。</p></div>}
    {isCombatNode&&<label className="check-row"><input type="checkbox" checked={Boolean(state.deployed)} disabled={!effective.recruitType} onChange={(e)=>onChange({deployed:e.target.checked,skill:e.target.checked?(state.skill??firstSkill):undefined,used:e.target.checked?state.used:undefined})}/> 本关编队</label>}
    {isCombatNode&&state.deployed&&<label className="check-row"><input type="checkbox" checked={Boolean(state.used)} onChange={(e)=>onChange({used:e.target.checked})}/> 本关部署</label>}
    <div><div className="field-title">当前精英化状态</div><div className="current-elite"><img src={asset(`icons/elite-${effective.elite??1}.svg`)}/><span>精英化 {effective.elite??1}</span></div><p className="hint">招募时可直接选择精一或精二；在任意节点标记晋升后，从下一个节点开始按精二记录。</p></div>
    <div><div className="field-title">{isCombatNode?"关卡结束后":"此节点之后"}</div><button className={`promotion-button ${state.promotionAfter===2?"active":""}`} disabled={!canPromoteAfter&&state.promotionAfter!==2} onClick={()=>onChange({promotionAfter:state.promotionAfter===2?undefined:2})}><img src={asset("icons/elite-2.svg")}/><span>{state.promotionAfter===2?`已标记：${isCombatNode?"本关后":"此节点后"}晋升精英化二`:`${isCombatNode?"本关后":"此节点后"}晋升精英化二`}</span></button>{effective.elite===2&&<p className="hint">该干员在此节点开始前已经是精英化二。</p>}</div>
    {isCombatNode&&<div><div className="field-title">本关部署技能</div>{availableSkills.length?<div className="segmented image-options">{availableSkills.map(info=><button key={info.index} disabled={!effective.recruitType} className={state.deployed&&state.skill===info.index?"active":""} onClick={()=>onChange({skill:info.index,deployed:true})}><img src={info.icon||asset("icons/skill-fallback.svg")}/><span>{info.name||`技能 ${info.index}`}</span></button>)}</div>:<p className="hint">PRTS 数据显示该干员没有可选择的技能。</p>}</div>}
  </div></Modal>;
}

function PresetLibrary({presets,status,onClose,onPreview,onCopy}:{presets:LoadedPreset[];status:string;onClose:()=>void;onPreview:(id:string)=>void;onCopy:(preset:LoadedPreset)=>void}) {
  return <Modal title="网站预设记录" onClose={onClose}><p className="muted">{status}</p>{presets.length?<div className="preset-list">{presets.map((preset)=><article className="preset-card" key={preset.id}><div className="preset-card-main"><div className="preset-card-title"><strong>{preset.name}</strong><span>{preset.theme}{preset.squad?` · ${preset.squad}`:""}</span></div>{preset.description&&<p>{preset.description}</p>}<div className="preset-meta">{preset.author&&<span>作者：{preset.author}</span>}{preset.event&&<span>活动：{preset.event}</span>}{preset.date&&<span>{preset.date}</span>}</div>{preset.tags?.length?<div className="preset-tags">{preset.tags.map((tag)=><span key={tag}>{tag}</span>)}</div>:null}</div><div className="preset-actions"><button className="ghost-button" onClick={()=>onPreview(preset.id)}>只读查看</button><button onClick={()=>onCopy(preset)}><Copy size={15}/> 复制到我的记录</button></div></article>)}</div>:<div className="empty-state"><p>还没有预设记录。</p><small>把导出的记录 JSON 放进 public/presets，并在 index.json 中登记即可。</small></div>}</Modal>;
}

function RunManager({store,onClose,onSelect,onCreate,onDelete}:{store:TrackerStore;onClose:()=>void;onSelect:(id:string)=>void;onCreate:()=>void;onDelete:(id:string)=>void}) { return <Modal title="保存与读取记录" onClose={onClose}><button className="wide-button" onClick={onCreate}><Plus size={16}/> 新建记录</button><div className="run-list">{[...store.runs].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(run=><div className={`run-card ${run.id===store.activeRunId?"active":""}`} key={run.id}><button className="run-open" onClick={()=>{onSelect(run.id);onClose();}}><strong>{run.name}</strong><span>{run.theme} · {new Date(run.updatedAt).toLocaleString("zh-CN")}</span></button><button className="danger-icon" disabled={store.runs.length===1} onClick={()=>onDelete(run.id)}><Trash2 size={16}/></button></div>)}</div></Modal> }
function Stats({run,operatorMap}:{run:RunState;operatorMap:Record<string,Operator>}) {
  const [query, setQuery] = useState("");
  const [profession, setProfession] = useState("all");
  const [rarity, setRarity] = useState(0);
  const [recruitType, setRecruitType] = useState<"all"|"normal"|"temporary">("all");
  const [sort, setSort] = useState<"pick"|"formation"|"deployment"|"skill"|"rarity"|"name">("pick");
  const [direction, setDirection] = useState<"desc"|"asc">("asc");

  const rows = useMemo(() => {
    const nodeIndex = new Map(run.nodes.map((node, index) => [node.id, index]));
    const baseRows = run.operators.flatMap((row, rowIndex) => {
      const operator = operatorMap[row.operatorId];
      if (!operator) return [];
      const recruitEntries = Object.entries(row.cells)
        .filter(([, cell]) => Boolean(cell.recruitType))
        .map(([nodeId, cell]) => ({ nodeIndex: nodeIndex.get(nodeId) ?? Number.MAX_SAFE_INTEGER, recruitType: cell.recruitType! }))
        .sort((a, b) => a.nodeIndex - b.nodeIndex);
      const firstRecruit = recruitEntries[0];
      const forms = operator.forms?.length ? operator.forms : [undefined];
      return forms.map((form) => {
        const op = form ? operatorForForm(operator, form.id) : operator;
        const formId = form?.id;
        return {
          rowIndex, row, op, formId,
          profession: normalizeProfession(op.profession),
          professionLabel: PROFESSIONS.find((item) => item.id === normalizeProfession(op.profession))?.label ?? "未知职业",
          recruitType: firstRecruit?.recruitType,
          recruitIndex: firstRecruit?.nodeIndex ?? Number.MAX_SAFE_INTEGER,
          deploys: countDeploysForForm(operator,row,run.nodes,formId),
          uses: countUsesForForm(operator,row,run.nodes,formId),
          s1: countSkillForForm(operator,row,run.nodes,formId,1),
          s2: countSkillForForm(operator,row,run.nodes,formId,2),
          s3: countSkillForForm(operator,row,run.nodes,formId,3),
        };
      });
    });

    // “一抓 / 二抓 / 三抓”只统计同职业的六星普通招募。
    // 临时招募不会占用正式抓位；同一节点同时招募时按干员行顺序稳定排序。
    const rankMap = new Map<string, number>();
    for (const professionItem of PROFESSIONS) {
      baseRows
        .filter((item) => item.op.rarity === 6 && item.profession === professionItem.id && item.recruitType === "normal")
        .sort((a, b) => a.recruitIndex - b.recruitIndex || a.rowIndex - b.rowIndex)
        .slice(0, 3)
        .forEach((item, index) => rankMap.set(item.op.id, index + 1));
    }

    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, "");
    const result = baseRows
      .map((item) => ({ ...item, pickRank: rankMap.get(item.op.id), skillTotal: item.s1 + item.s2 + item.s3 }))
      .filter((item) => !normalizedQuery || operatorSearchText(item.op).replace(/\s+/g, "").includes(normalizedQuery))
      .filter((item) => profession === "all" || item.profession === profession)
      .filter((item) => !rarity || item.op.rarity === rarity)
      .filter((item) => recruitType === "all" || item.recruitType === recruitType);

    result.sort((a, b) => {
      let comparison = 0;
      if (sort === "pick") comparison = (a.pickRank ?? 99) - (b.pickRank ?? 99) || a.recruitIndex - b.recruitIndex;
      else if (sort === "formation") comparison = a.deploys - b.deploys;
      else if (sort === "deployment") comparison = a.uses - b.uses;
      else if (sort === "skill") comparison = a.skillTotal - b.skillTotal;
      else if (sort === "rarity") comparison = a.op.rarity - b.op.rarity;
      else comparison = a.op.name.localeCompare(b.op.name, "zh-CN");
      if (comparison === 0) comparison = a.op.name.localeCompare(b.op.name, "zh-CN");
      return direction === "asc" ? comparison : -comparison;
    });
    return result;
  }, [run, operatorMap, query, profession, rarity, recruitType, sort, direction]);

  return <section className="panel stats-panel">
    <div className="eyebrow">STATISTICS</div>
    <div className="section-heading"><h2>干员编队与部署统计</h2><span className="muted">{rows.length} 名干员</span></div>
    <div className="stats-controls">
      <input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="搜索干员（支持拼音/首字母）" />
      <select value={profession} onChange={(event)=>setProfession(event.target.value)}><option value="all">全部职业</option>{PROFESSIONS.map((item)=><option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <select value={rarity} onChange={(event)=>setRarity(Number(event.target.value))}><option value={0}>全部星级</option>{[6,5,4,3,2,1].map((value)=><option key={value} value={value}>{value} 星</option>)}</select>
      <select value={recruitType} onChange={(event)=>setRecruitType(event.target.value as typeof recruitType)}><option value="all">全部招募</option><option value="normal">普通招募</option><option value="temporary">临时招募</option></select>
      <select value={sort} onChange={(event)=>setSort(event.target.value as typeof sort)}><option value="pick">六星抓位</option><option value="formation">编队次数</option><option value="deployment">部署次数</option><option value="skill">技能使用总次数</option><option value="rarity">星级</option><option value="name">名称</option></select>
      <select value={direction} onChange={(event)=>setDirection(event.target.value as typeof direction)}><option value="asc">升序</option><option value="desc">降序</option></select>
    </div>
    {rows.length?<div className="stats-table-wrap"><table><thead><tr><th>干员</th><th>职业</th><th>星级</th><th>六星抓位</th><th>编队</th><th>部署</th><th>一技能</th><th>二技能</th><th>三技能</th></tr></thead><tbody>{rows.map(r=><tr key={r.op.id}><td>{r.op.name}</td><td>{r.professionLabel}</td><td>{r.op.rarity}</td><td>{r.pickRank?<span className={`pick-badge pick-${r.pickRank}`}><span className="pick-medal">{r.pickRank===1?"金":r.pickRank===2?"银":"铜"}</span>{r.professionLabel}{r.pickRank===1?"一抓":r.pickRank===2?"二抓":"三抓"}</span>:<span className="muted">—</span>}</td><td>{r.deploys}</td><td>{r.uses}</td><td>{r.s1}</td><td>{r.s2}</td><td>{r.s3}</td></tr>)}</tbody></table></div>:<p className="muted">没有符合当前筛选条件的干员。</p>}
  </section>
}

type AggregateSource = { id: string; label: string; run: RunState; kind: "local" | "preset" | "file" };
type AggregateRow = {
  op: Operator;
  normalRecruit: number;
  temporaryRecruit: number;
  normalDeploy: number;
  temporaryDeploy: number;
  totalDeploy: number;
  totalUsed: number;
  firstPick: number;
  secondPick: number;
  thirdPick: number;
  runsSeen: number;
};

function AggregateStats({store,presets,operatorMap}:{store:TrackerStore;presets:LoadedPreset[];operatorMap:Record<string,Operator>}) {
  const [external, setExternal] = useState<AggregateSource[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("all");
  const [rarity, setRarity] = useState(0);
  const [recruitFilter, setRecruitFilter] = useState<"all"|"normal"|"temporary">("all");
  const [sort, setSort] = useState<"normalRecruit"|"temporaryRecruit"|"totalDeploy"|"totalUsed"|"firstPick"|"secondPick"|"thirdPick"|"runsSeen"|"rarity"|"name">("normalRecruit");
  const [direction, setDirection] = useState<"desc"|"asc">("desc");
  const analysisInput = useRef<HTMLInputElement>(null);

  const sources = useMemo<AggregateSource[]>(() => [
    ...store.runs.map((run) => ({ id: `local:${run.id}`, label: `本地 · ${run.name}`, run, kind: "local" as const })),
    ...presets.map((preset) => ({ id: `preset:${preset.id}`, label: `预设 · ${preset.name}`, run: preset.run, kind: "preset" as const })),
    ...external,
  ], [store.runs, presets, external]);

  const selectedRuns = useMemo(() => sources.filter((source) => !excluded.has(source.id)).map((source) => source.run), [sources, excluded]);
  const themeOptions = useMemo(() => [...new Set(sources.map((source) => source.run.theme))], [sources]);

  const rows = useMemo(() => {
    const map = new Map<string, AggregateRow>();
    for (const run of selectedRuns) {
      if (theme !== "all" && run.theme !== theme) continue;

      // 计算本局每个职业六星干员的普通招募顺位。临时招募不占抓位。
      const professionPickCounts = new Map<string, number>();
      const pickRanks = new Map<string, 1 | 2 | 3>();
      for (let nodeIndex = 0; nodeIndex < run.nodes.length; nodeIndex++) {
        const node = run.nodes[nodeIndex];
        for (const runOperator of run.operators) {
          const cell = runOperator.cells[node.id];
          if (cell?.recruitType !== "normal") continue;
          const baseOperator = operatorMap[runOperator.operatorId];
          if (!baseOperator) continue;
          const formId = resolveEffectiveFormId(baseOperator, runOperator, run.nodes, nodeIndex);
          const recruitedOperator = formId ? operatorForForm(baseOperator, formId) : baseOperator;
          if (recruitedOperator.rarity !== 6) continue;
          const profession = normalizeProfession(recruitedOperator.profession);
          const rank = (professionPickCounts.get(profession) ?? 0) + 1;
          professionPickCounts.set(profession, rank);
          if (rank <= 3) pickRanks.set(`${runOperator.operatorId}:${node.id}`, rank as 1 | 2 | 3);
        }
      }

      for (const row of run.operators) {
        const operator = operatorMap[row.operatorId];
        if (!operator) continue;
        const forms = operator.forms?.length ? operator.forms : [undefined];
        const recruited = Object.values(row.cells).some((cell) => Boolean(cell.recruitType));
        forms.forEach((form, formIndex) => {
          const op = form ? operatorForForm(operator, form.id) : operator;
          const key = op.id;
          let aggregate = map.get(key);
          if (!aggregate) {
            aggregate = { op, normalRecruit: 0, temporaryRecruit: 0, normalDeploy: 0, temporaryDeploy: 0, totalDeploy: 0, totalUsed: 0, firstPick: 0, secondPick: 0, thirdPick: 0, runsSeen: 0 };
            map.set(key, aggregate);
          }
          // 多形态干员共享同一次招募与抓位数据；编队、部署和技能仍按形态分别统计。
          if (recruited) aggregate.runsSeen += 1;
          for (let nodeIndex=0; nodeIndex<run.nodes.length; nodeIndex++) {
            const node=run.nodes[nodeIndex];
            const cell=row.cells[node.id];
            if (!cell) continue;
            if (cell.recruitType === "normal") aggregate.normalRecruit += 1;
            if (cell.recruitType === "temporary") aggregate.temporaryRecruit += 1;
            const currentForm=resolveEffectiveFormId(operator,row,run.nodes,nodeIndex);
            if (cell.recruitType === "normal") {
              const rank = pickRanks.get(`${row.operatorId}:${node.id}`);
              if (rank === 1) aggregate.firstPick += 1;
              else if (rank === 2) aggregate.secondPick += 1;
              else if (rank === 3) aggregate.thirdPick += 1;
            }
            if (currentForm !== form?.id) continue;
            if (cell.used) aggregate.totalUsed += 1;
            if (cell.deployed) {
              aggregate.totalDeploy += 1;
              const effectiveRecruitType = resolveEffectiveState(row, run.nodes, nodeIndex).recruitType;
              if (effectiveRecruitType === "temporary") aggregate.temporaryDeploy += 1;
              else aggregate.normalDeploy += 1;
            }
          }
        });
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
          additions.push({ id: `file:${file.name}:${run.id}:${uid()}`, label: `${file.name} · ${run.name}`, run, kind: "file" });
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
      <div><div className="eyebrow">MULTI-RUN ANALYSIS</div><h2>综合抓位与使用统计</h2><p className="muted">当前纳入 {selectedRuns.length} 个记录；预设和导入的 JSON 仅用于分析，不会覆盖本地存档。</p></div>
      <div className="top-actions"><button className="ghost-button" onClick={() => analysisInput.current?.click()}><Upload size={16}/> 导入分析 JSON</button>{external.length>0&&<button className="ghost-button" onClick={()=>setExternal([])}><Trash2 size={16}/> 清除导入</button>}<input ref={analysisInput} hidden multiple type="file" accept="application/json" onChange={(event)=>event.target.files&&addAnalysisFiles(event.target.files)}/></div>
    </div>
    <details className="source-selector"><summary>选择参与统计的记录（{selectedRuns.length}/{sources.length}）</summary><div className="source-grid">{sources.map((source)=><label key={source.id} className="check-row"><input type="checkbox" checked={!excluded.has(source.id)} onChange={()=>toggleSource(source.id)}/><span>{source.label}</span><small>{source.run.theme}</small></label>)}</div></details>
    <div className="aggregate-controls">
      <input placeholder="搜索干员" value={query} onChange={(e)=>setQuery(e.target.value)}/>
      <select value={theme} onChange={(e)=>setTheme(e.target.value)}><option value="all">全部肉鸽</option>{themeOptions.map((value)=><option key={value}>{value}</option>)}</select>
      <select value={rarity} onChange={(e)=>setRarity(Number(e.target.value))}><option value={0}>全部星级</option>{[6,5,4,3,2,1].map((value)=><option key={value} value={value}>{value} 星</option>)}</select>
      <select value={recruitFilter} onChange={(e)=>setRecruitFilter(e.target.value as typeof recruitFilter)}><option value="all">全部招募类型</option><option value="normal">有普通招募</option><option value="temporary">有临时招募</option></select>
      <select value={sort} onChange={(e)=>setSort(e.target.value as typeof sort)}><option value="normalRecruit">普通抓取次数</option><option value="temporaryRecruit">临时抓取次数</option><option value="totalDeploy">编队次数</option><option value="totalUsed">部署次数</option><option value="firstPick">同职业一抓次数</option><option value="secondPick">同职业二抓次数</option><option value="thirdPick">同职业三抓次数</option><option value="runsSeen">出现局数</option><option value="rarity">星级</option><option value="name">名称</option></select>
      <select value={direction} onChange={(e)=>setDirection(e.target.value as typeof direction)}><option value="desc">降序</option><option value="asc">升序</option></select>
    </div>
    {rows.length?<div className="stats-table-wrap"><table><thead><tr><th>干员</th><th>星级</th><th>普通抓取</th><th>临时抓取</th><th>编队</th><th>部署</th><th>同职业一抓</th><th>同职业二抓</th><th>同职业三抓</th><th>出现局数</th></tr></thead><tbody>{rows.map((row)=><tr key={row.op.id}><td><div className="stats-operator"><OperatorAvatar operator={row.op} size={34}/><span>{row.op.name}</span></div></td><td>{row.op.rarity}</td><td>{row.normalRecruit}</td><td>{row.temporaryRecruit}</td><td>{row.totalDeploy}</td><td>{row.totalUsed}</td><td>{row.op.rarity===6?row.firstPick:<span className="muted">—</span>}</td><td>{row.op.rarity===6?row.secondPick:<span className="muted">—</span>}</td><td>{row.op.rarity===6?row.thirdPick:<span className="muted">—</span>}</td><td>{row.runsSeen}</td></tr>)}</tbody></table></div>:<p className="muted">当前筛选条件下没有数据。</p>}
  </section>;
}

function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}) { return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e=>e.stopPropagation()}><div className="modal-header"><h3>{title}</h3><button onClick={onClose}><X size={18}/></button></div>{children}</div></div> }
function resolveEffectiveFormId(operator:Operator,row:RunOperator,nodes:TimelineNode[],index:number):string|undefined {
  if (!operator.forms?.length) return undefined;
  for (let i=index;i>=0;i--) {
    const formId=row.cells[nodes[i]?.id]?.formId;
    if (formId&&operator.forms.some((form)=>form.id===formId)) return formId;
  }
  return operator.forms[0]?.id;
}

function resolveEffectiveState(row:RunOperator,nodes:TimelineNode[],index:number):CellState {
  const result:CellState={};
  if(index<0)return result;
  for(let i=0;i<=index;i++){
    const cell=row.cells[nodes[i].id];
    if(!cell)continue;
    if(cell.recruitType){result.recruitType=cell.recruitType;result.elite=cell.elite??1;}
    // 兼容旧记录：非招募节点上的 elite 仍按立即晋升处理。
    if(cell.elite&&!cell.recruitType&&(!result.elite||cell.elite>result.elite))result.elite=cell.elite;
    // 新记录中的 promotionAfter 只从下一个节点开始生效。
    if(i<index&&cell.promotionAfter===2)result.elite=2;
  }
  return result;
}
function countDeploys(row:RunOperator){return Object.values(row.cells).filter(c=>c.deployed).length;} function countUses(row:RunOperator){return Object.values(row.cells).filter(c=>c.used).length;} function countSkill(row:RunOperator,skill:Skill){return Object.values(row.cells).filter(c=>c.used&&c.skill===skill).length;}
function countDeploysForForm(operator:Operator,row:RunOperator,nodes:TimelineNode[],formId?:string){return nodes.filter((node,index)=>row.cells[node.id]?.deployed&&resolveEffectiveFormId(operator,row,nodes,index)===formId).length;}
function countUsesForForm(operator:Operator,row:RunOperator,nodes:TimelineNode[],formId?:string){return nodes.filter((node,index)=>row.cells[node.id]?.used&&resolveEffectiveFormId(operator,row,nodes,index)===formId).length;}
function countSkillForForm(operator:Operator,row:RunOperator,nodes:TimelineNode[],formId:string|undefined,skill:Skill){return nodes.filter((node,index)=>{const cell=row.cells[node.id];return cell?.used&&cell.skill===skill&&resolveEffectiveFormId(operator,row,nodes,index)===formId;}).length;}
export default App;

export type Elite = 1 | 2;
export type Skill = 1 | 2 | 3;
export type NodeType = "initial" | "combat";

export type TimelineNode = {
  id: string;
  floor: number;
  type: NodeType;
  stageId?: string;
  name: string;
};

export type CellState = {
  recruitType?: "normal" | "temporary";
  deployed?: boolean;
  elite?: Elite;
  skill?: Skill;
};

export type RunOperator = {
  operatorId: string;
  cells: Record<string, CellState>;
};

export type RunState = {
  id: string;
  name: string;
  theme: string;
  squad: string;
  createdAt: string;
  updatedAt: string;
  nodes: TimelineNode[];
  operators: RunOperator[];
};

export type TrackerStore = {
  schemaVersion: 2;
  activeRunId: string;
  runs: RunState[];
};

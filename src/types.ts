export type Elite = 1 | 2;
export type Skill = 1 | 2 | 3;
export type NodeType = "initial" | "combat" | "event" | "shop" | "encounter" | "other";

export type TimelineNode = {
  id: string;
  floor: number;
  type: NodeType;
  stageId?: string;
  prtsUrl?: string;
  prtsUrls?: string[];
  categoryId?: string;
  categoryName?: string;
  sectionCode?: string;
  sectionName?: string;
  name: string;
};

export type CellState = {
  recruitType?: "normal" | "temporary";
  deployed?: boolean;
  used?: boolean;
  elite?: Elite;
  promotionAfter?: 2;
  skill?: Skill;
  formId?: string;
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

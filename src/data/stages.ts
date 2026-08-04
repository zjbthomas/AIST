export type Stage = {
  id: string;
  theme: string;
  name: string;
  floor: number;
  sectionCode: string;
  sectionName: string;
  categoryId: string;
  categoryName: string;
  variant: string;
  prtsUrl: string;
};

export const themes = [
  "傀影与猩红孤钻",
  "水月与深蓝之树",
  "探索者的银凇止境",
  "萨卡兹的无终奇语",
  "岁的界园志异",
  "沉沦者的黑流树海",
];

export const squads = [
  "指挥分队",
  "集群分队",
  "后勤分队",
  "矛头分队",
  "突击战术分队",
  "堡垒战术分队",
  "远程战术分队",
  "破坏战术分队",
];

const makeStage = (theme: string, floor: number, name: string, variant: "normal" | "emergency" = "normal"): Stage => ({
  id: `${theme}|ISW-NO|${floor}|${variant}|${name}`,
  theme,
  name,
  floor,
  sectionCode: "ISW-NO",
  sectionName: "一般作战 & 紧急作战",
  categoryId: `ISW-NO:${variant}`,
  categoryName: variant === "normal" ? "一般作战" : "紧急作战",
  variant,
  prtsUrl: `https://prts.wiki/w/${encodeURIComponent(name)}`,
});

export const stages: Stage[] = themes.flatMap((theme) => [
  makeStage(theme, 1, "驯兽小屋", "normal"),
  makeStage(theme, 1, "驯兽小屋", "emergency"),
]);

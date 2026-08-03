export type Stage = {
  id: string;
  theme: string;
  name: string;
  floor: number;
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

const makeStage = (theme: string, floor: number, name: string): Stage => ({
  id: `${theme}-${floor}-${name}`,
  theme,
  name,
  floor,
  prtsUrl: `https://prts.wiki/w/${encodeURIComponent(name)}`,
});

export const stages: Stage[] = themes.flatMap((theme) => [
  makeStage(theme, 1, "驯兽小屋"),
  makeStage(theme, 1, "共生"),
  makeStage(theme, 2, "射手部队"),
  makeStage(theme, 2, "意外"),
  makeStage(theme, 3, "据险固守"),
  makeStage(theme, 3, "紧急运输"),
  makeStage(theme, 4, "寒灾之咒"),
  makeStage(theme, 5, "最终调查"),
]);

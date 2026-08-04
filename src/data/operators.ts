export type OperatorSkill = { index: 1 | 2 | 3; name: string; icon: string };
export type Operator = {
  id: string;
  name: string;
  rarity: 1 | 2 | 3 | 4 | 5 | 6;
  profession?: string;
  avatar: string;
  skills: OperatorSkill[];
  prtsUrl: string;
};

const redirect = (filename: string) => `https://prts.wiki/index.php?title=Special:Redirect/file/${encodeURIComponent(filename)}`;
const op = (name: string, rarity: Operator["rarity"], skillNames: string[] = [], profession = "WARRIOR"): Operator => ({
  id: name,
  name,
  rarity,
  profession,
  avatar: redirect(`头像_${name}.png`),
  skills: skillNames.slice(0, 3).map((skillName, i) => ({
    index: (i + 1) as 1 | 2 | 3,
    name: skillName,
    icon: redirect(`技能_${skillName}.png`),
  })),
  prtsUrl: `https://prts.wiki/w/${encodeURIComponent(name)}`,
});

// scripts/sync-prts.mjs 会在 npm run dev/build 前生成 public/data/operators.json，
// 此列表只用于首次启动或 PRTS 暂时不可访问时兜底。
export const fallbackOperators: Operator[] = [
  op("棘刺", 6, ["攻击力强化·γ型", "护身尖刺", "至高之术"]),
  op("史尔特尔", 6, ["烈焰魔剑", "熔核巨影", "黄昏"]),
  op("艾雅法拉", 6, ["二重咏唱", "点燃", "火山"]),
  op("缄默德克萨斯", 6),
  op("拉普兰德", 5),
  op("幽灵鲨", 5),
  op("桃金娘", 4),
  op("孑", 4),
  op("斑点", 3),
  op("克洛丝", 3),
  op("黑角", 2),
  op("Castle-3", 1),
];

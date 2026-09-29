# 帆船赛现场控制和申诉处理

竞赛官维护组别、航线、起航时间和比赛状态，计时员提交原始到岸数据，裁判通过**追加式裁决台账**处理抗议处罚、重赛、弃权和免责。正式排行榜由“冻结原始成绩 + 台账重算出版本”得到，发布后只认最新版本，旧版本全程可追溯。

## 技术栈

React 19、TypeScript、Vite、Ant Design、Redux Toolkit、RTK Query、React Router、React Hook Form、Zod、i18next。

## 本地运行

```bash
npm install
npm run dev          # 开发，端口 62024
npm run check        # 类型检查
npm run build        # 生产构建
```

领域规则与老数据迁移验证脚本：

```bash
npx esbuild scripts/verify-domain.ts --bundle --platform=node --format=esm --outfile=scripts/.verify.mjs \
  && node scripts/.verify.mjs
npx esbuild src/store.ts --bundle --platform=node --format=cjs --outfile=scripts/tmp-store.cjs --log-level=error \
  && node scripts/verify-migration.cjs
```

## 成绩与裁决模型（按比赛版本）

- **冻结**：比赛结束（所有船登记原始用时后）即刻冻结原始成绩，生成 v1；冻结快照永不修改，计时员此后不能再改秒数。
- **追加裁决台账**：抗议处罚（加秒）、免责/撤销处罚（减秒）、重赛成绩（替换该船显示用时）、弃权（RET，排末尾）、撤销弃权、抗议驳回（不改成绩仅留痕）均只追加；每条带顺序号 `seq`、提交方（计时员/裁判/竞赛官）和所依据的尾号 `baseSeq`。
- **晚到裁决重算**：未发布时追加裁决立即基于当前台账重算，生成新的“重算稿”，排行榜显示最新稿。
- **发布后更正版**：正式成绩发布后再追加裁决，只生成“更正版”，正式排行榜保持不变，直到裁判组再次发布。
- **并发接续**：计时员和裁判同时提交（`baseSeq` 落后于台账尾号）时，后到的裁决追加在队尾并基于已登记裁决继续计算，绝不覆盖先到的处罚或重赛；台账上标注“基于 #x → 接续 #y”。
- **发布**：只有当前最新版本可发布为正式成绩；旧正式版转为“已被取代”，但连同各行成绩快照全部保留可追溯。
- **老数据升级**：localStorage 中的 v1 数据自动迁移到 `regatta-control-v2`——旧处罚秒数转为带 `legacy` 标记的历史裁决，旧 official 标记沿用为发布动作，旧时间线保留并补记一条升级事件；v2 数据再次打开会做字段补全。

## 可用流程

- 竞赛控制：起航倒计时、开始/结束比赛（结束即冻结）、冻结前录入或修改原始到岸用时、查看正式排行榜（正式版或最新更正版）。
- 裁决台账：选择船只和裁决类型追加；查看追加式台账；展开查看每个成绩版本的完整榜单；一键发布最新版；“模拟计时员/裁判同时提交”演示并发接续。
- 抗议处理：登记抗议、进入复核、接受并加罚 / 判弃权 / 驳回，裁决自动写入台账并重算或生成更正版。
- 时间线：按比赛记录比赛状态、冻结、裁决、重算、发布、抗议和系统升级全过程。
- 数据使用 localStorage 持久化（`regatta-control-v2`），页头可切换比赛、重置演示数据。

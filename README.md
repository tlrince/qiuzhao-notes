# 秋招投递管理

按 [plan.md](plan.md) 分模块开发。当前完成 **M0：领域契约与测试数据** 与 **M1：设计系统与应用外壳**。已有可运行的响应式 Web 界面，业务录入、统计和持久化尚未接入。

## 本地验证

需要 Node.js 22.12+ 和 npm。

```sh
npm ci
npm run typecheck
npm run test:m0
npx playwright install chromium
npm run test:m1
npm run build
```

`test:m0` 先编译 TypeScript，再通过 Node 内置测试运行器执行独立测试；不依赖浏览器、数据库或外部服务。依赖版本已锁定在 package-lock.json。

## 模块入口

- `src/domain/types.ts`：实体、查询、命令、分析与备份的类型契约。
- `src/domain/rules.ts`：可独立验证的状态规则纯函数，供内存 Mock 使用，后续 M2 可在事务内复用。
- `src/domain/validation.ts`：日期、时区、招聘季与岗位详情校验。
- `src/repositories/contracts.ts`：Repository、备份及变更订阅协议。
- `src/repositories/memory.ts`：与正式接口一致的岗位、日程、工作空间内存实现。
- `src/fixtures/acceptance.ts`：显式加载的 A–F 样例与 M5 验收预期常量。
- `tests/m0.test.mjs`：M0 独立验收。
- `docs/M0.md`：冻结规则、用法与验收记录。

## 界面预览

```sh
npm run dev -- --host 127.0.0.1
```

打开终端显示的本地地址，默认进入深度分析空态。侧栏可导航至五个页面；手机通过菜单展开导航。

- `/design-system`：按钮、阶段徽标、保存状态、抽屉、未保存确认和招聘季切换的独立预览。
- 默认没有招聘季、演示投递或已保存提示。组件页可以显式开启示例招聘季，刷新重置。
- 新增投递与导出按钮尚不可用，页面有明确说明；M1 不写入浏览器业务存储。
- `src/app/`：应用路由、外壳和响应式样式。
- `src/shared/ui/`：共用基础组件与原生模态抽屉。
- `docs/M1.md`：组件契约、浏览器验收与截图。
- `docs/M2.md`：事务、IndexedDB、SQLite 与独立验收记录。
- `npm run build` 输出 Web 资源至 `web-dist/`；M0 独立编译仍输出至 `dist/`。

下一模块为 M3：投递管理。每次只开发并验收一个模块；可将同一模块内相互独立的任务交给沿用当前模型的子 agent 并行完成。

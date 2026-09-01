# Assets 模块

`asset-cost` 是 custom 镜像内置、可在“设置 → 启用模块”中开关的原生页面，用来计算资产的使用天数、日均成本和出售后的净日均成本。它复用 Inventory，不创建第二套资产表，也不直接从前端访问 `yuvomi.db`。

不需要新增 Docker 服务、容器或手工复制模块目录。新机器只要拉取 custom 镜像，页面代码就已包含在镜像中；数据库会通过现有迁移机制升级到 v176。用户关闭模块后只隐藏入口，不删除 Inventory 数据。

## 图片搜索

图片搜索通过 Yuvomi 的同源 API 完成：

- 配置 `ASSET_COST_GOOGLE_API_KEY` 和 `ASSET_COST_GOOGLE_CSE_ID` 时，优先调用 Google Programmable Search 的图片搜索；
- 未配置或 Google 暂时不可用时，回退到 Openverse 的开放图片结果；
- API key 只在服务端使用，不会返回给浏览器；
- 选中的图片先通过安全预览代理下载，再由浏览器裁剪为本地 `photo_data`；
- 不保存第三方图片 URL。

Google Custom Search JSON API 目前只对已有客户开放，并计划在 2027-01-01 停止服务。因此图片搜索实现保留了 provider 适配边界，后续可替换为其他具有 API 的全网图片搜索服务，不需要修改 Assets 页面的结构。

在 `.env` 中只填写服务端配置（不要放进模块或浏览器代码）：

```text
ASSET_COST_GOOGLE_API_KEY=your-server-side-key
ASSET_COST_GOOGLE_CSE_ID=your-search-engine-id
```

Google CSE 未配置时，Openverse 回退搜索仍可用；它的结果可能不包含某些精确商品型号。

搜索不到精确商品型号时，可以继续使用上传图片。

## Inventory 扩展字段

模块使用 Inventory 的以下可选字段：

- `sold_date`
- `sold_price`
- `retired_date`
- `target_days`
- `asset_scope`（`family` / `personal`）
- `visibility`（`all` / `assignees` / `private`）
- `inventory_item_assignments`（指定可见成员）

这些字段由 Inventory API 的迁移和校验逻辑管理，模块只通过 `/api/v1/inventory` 读写。

## 家庭、个人与共享

- 家庭资产由管理员创建、编辑和删除；管理员始终可以管理家庭资产。
- 个人资产归创建者本人，默认仅本人可见和管理。
- 个人资产可以共享给所有家庭成员或指定成员；被共享者只有查看权限。
- 管理员不会绕过另一个用户个人资产的私密设置。
- 升级前已有的 Inventory 记录迁移为全员可见的家庭资产，保持原有行为。

## 计算规则

- 服役中：`days_used = today - purchase_date`，`cost_per_day = purchase_price / days_used`。
- 已卖出：结束日使用 `sold_date`（未填时取今天），`cost_per_day = (purchase_price - sold_price) / days_used`。
- 已退役/遗失：结束日使用 `retired_date`（未填时取今天），成本仍按购买价计算。
- 购买当天按 1 天计算，避免除以 0；所有日期运算使用本地日历日期，不把日期字段转换成 UTC 时间戳。
- 统计卡只合计当前选择币种；卡片保留资产自身币种，不做未经汇率依据的跨币种相加。

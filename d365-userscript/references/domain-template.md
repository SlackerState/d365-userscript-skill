# 组织内已查实的结构（模板）

复制为 `references/domain.md`，把调查结果记在这里。里面是组织内部信息，不要提交到公开仓库。D365 配置会变，写入类功能使用前要再核对一次。

## 实体

| 业务名 | 逻辑名 | 实体集 | 常用字段 |
|---|---|---|---|
| 示例：订单 | `new_order` | `new_orders` | `new_ordernumber`、`new_orderstatus`、`_new_customer_value` |

## 选项值

| 字段 | 值 |
|---|---|
| 示例：订单 `new_orderstatus` | 10 = 草稿、20 = 已提交 |

## 接口

| 接口 | 用途 | 参数 |
|---|---|---|
| 示例：`POST new_withdrawapi` | 撤销审批 | `{ EntityId, EntityName }` |

## 页面脚本

- 示例：订单表单按钮的 Web Resource 路径和函数名

## 现有脚本

| 文件 | 做什么 | 在线更新 |
|---|---|---|
| 示例：`订单批量提交.user.js` | 读取 → 分类 → 预检查 → 提交 | 有 |

# Data Dictionary

本文件在第一次真实直播测试后填写。Dashboard 当前可导出/查看的数据已经按照下列维度组织：

## EVENT: chat

- 出现次数：待真实直播观察
- 确认字段：`user.id`, `user.uniqueId`, `user.nickname`, `payload.text`, `payload.commandText`
- 可空字段：用户身份字段
- 样例：`{"text":" RED ","commandText":"red"}`
- 游戏设计价值：即时命令、个人行为、阵营选择

## EVENT: gift

- 出现次数：待真实直播观察
- 确认字段：`giftId`, `giftName`, `count`, `giftType`, `repeatEnd`, `diamondCount`
- 可空字段：所有礼物字段均按协议允许缺失
- combo 行为：streak 进行中产生 `gift_progress`，仅最终 `repeatEnd=true` 的 count 进入结算
- 游戏设计价值：稀有即时反馈、个人能力或全局资源

## EVENT: like

- 出现次数/频率：待真实直播观察
- 字段：`count`, `totalLikes`
- 游戏设计价值：能量、积分、阶段阈值

## EVENT: member / roomUser

- 出现次数/频率：待真实直播观察
- 是否过于密集：待观察
- 游戏设计价值：加入事件、房间规模和全局压力指标

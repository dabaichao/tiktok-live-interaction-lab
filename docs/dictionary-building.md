# 中文直播猜词词库建设与增量发布

当前游戏使用 `DictionarySnapshot` v1，内置包默认语言现为 `zh-Hans`。**词库与题库不是两个互相叠加的文件**：一份标准 JSON 包同时含可猜词和可出题词；后台的“词库包/题目库”只是导入分类，运行时只启用一个完整包。因此每次发布都从现有包增量合并，而不是上传仅有新增词的差分文件。
后台显示的“词库包数/题目库数”是**导入包的数量**，不是词条数量。发布命令会另行打印该包的中文题目数和可猜词数。

## 数据规则

| 内容 | 标准字段 | 游戏用途 |
| --- | --- | --- |
| 题目/答案 | `labels["zh-Hans"]`、`isAnswerable: true`、`status: "approved"` | 可被下一局抽为答案 |
| 随机/可猜词 | `isGuessable: true`、`status: "approved"` | 点赞、礼物随机词与概念索引 |
| 题目关联 | 猜词概念的 `relatedTo: ["题目"]`、可选 `relationLevel` | 本地随机词优先抽取当前题目的审核关联词，仍以全局词库补充 |
| 第一阶段方向提示 | `definitions["zh-Hans"]` | 运行中的“方向提示” |
| 待审核 AI 候选 | 审核文件内 `status: "pending"` | **不会进入游戏** |

例如“苹果”是题目时，第一条提示可为“一种常见的水果”；不应写“红绿两色、圆形、可做果汁”等高度定向线索，更不能包含“苹果”、同义答案、拼音或首字。当前游戏后续阶段仍按现有规则显示首字和答案长度，脚本**只管理第一阶段方向提示**，不会假称已经支持逐题自定义多阶段谜面。两字题目在后期给出首字时较易被猜中，正式上线前应检查关卡难度。

题目与随机词优先按同一字数成组扩充。例如当前答案多为 2 字，则先积累数百个 2 字随机词；不同字数的随机词不会参与这轮自动猜词。审核时还要检查词义清晰、不能是歧义别名、是否适合目标直播观众。

先盘点现有包：

```powershell
python tools/dictionary_builder.py stats --base data/dictionaries/multilingual_core_v1.json
```

本次本地盘点：内置包共有 119 个概念，其中 104 个有中文词面（2 字词 88 个），可作为中文题目的词里有 103 个缺专属方向提示，另有 2 个中文词面跨概念歧义。缺提示时游戏会回退到通用类别文案；因此**优先补旧题提示、清理歧义，再大批量扩题**。脚本会跳过有歧义词面的自动补提示，留待人工处理。

## AI 提示词

脚本中的完整系统提示词在 [`tools/dictionary_builder.py`](../tools/dictionary_builder.py) 的 `BATCH_SYSTEM_PROMPT`（批量题库）、`ANSWER_SYSTEM_PROMPT`（单题）、`SYSTEM_PROMPT`（自由扩词）和 `HINT_SYSTEM_PROMPT`（补旧题提示），核心约束为：

> 输出严格 JSON `{"items":[{"word":"苹果","role":"answer","category":"food","partOfSpeech":"名词","hint":"一种常见的水果"}]}`。词语限 2～4 个简体汉字，题目提示只说宽泛类别或用途，不含答案、别名、拼音、字形和独有特征。随机词的 `hint` 为空。只选全年龄、非专名、非争议的稳定普通词。热点标题仅供取材，不能照抄或把人物、机构、事件直接变成题目。

批量模式要求模型返回 `{"questions":[{"answer":"森林","category":"nature","partOfSpeech":"名词","hint":"许多树木生长的地方","relatedWords":[{"word":"树木","category":"nature","partOfSpeech":"名词","relationLevel":"near"}]}]}`。每个请求默认处理 4 道题，各题有独立答案、宽泛提示与同字数的近/中/远关联猜词；并传入已有词及可选热点标题以减少重复。响应经过 JSON、字数、类别、敏感片段、去重、提示泄题和“至少一条有效相关词”检查，随后只进入待审核文件。发布时保留每个相关词所属题目；游戏本地随机词会优先使用该题关联词，但仍可抽全局词，避免相关词少时反复重复。**规则与第二个模型的审核都不能保证内容绝对合规；商业直播仍建议抽样复核。**

## 生成、审核、发布

只需 Python 3.11+ 标准库，不需要安装包。当前本机私有配置 `data/dictionary-proposals/.wordlib-local.json` 已存模型地址、模型 ID 和密钥，生成脚本会自动读取；此文件位于 Git 忽略目录，**含明文密钥，严禁上传、截图、复制到提交内容或分享给他人**。优先级为环境变量 > 本机私有配置 > Windows DPAPI 加密缓存 > 首次交互输入。移走私有配置后，首次直接运行可不回显输入密钥并用当前 Windows 账号加密保存到同目录的 `.wordlib-api-key.dpapi`。该加密文件不能跨 Windows 账号或电脑解密。`key-cache status` 会显示是否存在本机配置，不显示密钥；`key-cache clear` 只清除 DPAPI 缓存，不删除私有明文配置。

如果使用 Windows CMD 且想执行以下相对路径命令，先切换盘符和目录：

```cmd
cd /d "E:\项目内容\Tik Tok直播测试游戏"
```

PowerShell 也可通过不回显输入临时设置：

```powershell
$wordlibSecret = Read-Host '请输入新的 API Key' -AsSecureString
$env:WORDLIB_API_KEY = [System.Net.NetworkCredential]::new('', $wordlibSecret).Password
```

你给的服务地址是**公网 HTTP**。HTTP 会明文传输密钥；优先请服务方开启 HTTPS。只有你明确接受风险时才加 `--allow-insecure-http`。下例使用 HTTPS 占位地址，应替换成实际可用的 HTTPS 地址：

```powershell
python tools/dictionary_builder.py batch --question-count 40 --related-per-question 5 --batch-size 4 --api-base https://你的服务地址/v1
```

不指定题目时，`batch` 会让模型提出新题。若已有大量备选题目，可一次传入：

```powershell
python tools/dictionary_builder.py batch --answers "生日,森林,海洋" --related-per-question 5 --api-base https://你的服务地址/v1
```

或准备 UTF-8 文本文件 `answers.txt`，每行一题（也接受 JSON 字符串数组），用 `--answers-file answers.txt`。可混合 2～4 字题目；各题相关词会分别按答案字数生成。一次最多 100 道题，每题相关词目标数为 1～20；数量较多时脚本会自动缩小每次请求的题数（例如每题 20 词时最多同时请求 2 道题），避免一份 JSON 输出过长。每批完成后立刻保存，同一审核文件可继续增量运行。目标数不是保证数：模型漏词或本地校验、去重拒绝的词不会凑数，应查看实际完成数量后再补充。

批量模式默认请求 `hy3` 的 `reasoning_effort: "low"` 和 JSON 对象模式；若上游不支持 JSON 模式，会自动回退到普通模式。低思考只是请求参数，是否真正减少思考 token 由接口决定；可用 `--reasoning-effort default` 恢复模型默认，或 `--no-json-mode` 关闭 JSON 模式。模型返回截断或无效 JSON 时，脚本先缩小题目批次，缩到单题后最多再试两次；已完成的候选仍逐批保存。若反复失败会停止并报告，不会把残缺词条当作成功。

`deepseek-v4.1-flash` 已实测支持 `thinking: {"type":"disabled"}`；批量生成时可用 `--model deepseek-v4.1-flash --disable-thinking` 请求关闭思考，避免思考 token 占满输出额度。该选项只应给已验证支持关闭思考的模型使用；诊断记录会标明是否发送了关闭思考参数。指定题目批量生成时，某一道题反复不合格会轮转到队尾，最多尝试三次，其他题继续，不会被第一道难题卡住。未完成题目会明确列出，不能算作已入库。

默认诊断文件为 `data/dictionary-proposals/model-diagnostics.jsonl`，它随整个目录被 Git 忽略。每笔只记录时间、模型、批次、题数、HTTP 状态、结束原因、正文长度、completion/reasoning token 数及解析状态，**不记录密钥、请求提示词或模型原文**。可以用 `--diagnostics 路径` 另选位置；不要把该路径放到公开目录。若再出错，可据 `finish_reason=length` 与 token 用量区分截断和格式不合规。

在 CMD 或 PowerShell 中直接运行 `python "E:\项目内容\Tik Tok直播测试游戏\tools\dictionary_builder.py"` 会进入批量向导：输入多个题目并用逗号分隔，或输入 `@文件路径`；留空则让模型自动出题。随后填写新题数（仅留空自动出题时）和每题相关词数。当前本机配置使用模型 ID `hy3`，无需再次输入 API Key。若使用公网 HTTP，每次运行都会警告并要求输入 `yes` 或 `YES`；直接回车会安全取消。**本机配置不能加密公网 HTTP 传输，优先改用 HTTPS。不会自动发布到直播。**审核文件默认位于 `data/dictionary-proposals/zh-review.json`。

如果不想指定题目，只想扩大通用随机词池，还可以运行：

```powershell
python tools/dictionary_builder.py generate --review data/dictionary-proposals/zh-review.json --count 40 --word-length 2 --api-base https://你的服务地址/v1
```

模型默认从本机私有配置读取，当前为 `hy3`；可用 `--model` 改。每批会保存审核文件，失败后可以用相同参数继续运行，但 `--count` 指的是**本次新增数量**，不是审核文件总量。脚本默认最多 50 次请求，不会一次性让模型产出上千词。`--batch-size` 最高 40，`--count` 每次最高 500。

给现有题目补提示使用同一审核文件、同样的人工审批机制：

```powershell
python tools/dictionary_builder.py generate-hints --base data/dictionaries/multilingual_core_v1.json --review data/dictionary-proposals/zh-hints-review.json --count 100 --batch-size 8 --word-length all --api-base https://你的服务地址/v1
```

这只选择**目前缺中文方向提示的旧题**，模型按题目、词性、类别及别名提议第一阶段提示，不会自行新增答案。`--base` 应填写实际准备增量的完整包路径，而不是每次使用内置旧包。`--word-length all` 同时处理已有的 1～4 字题目，也可指定 `1`、`2`、`3`、`4`；这不改变新增题目仅支持 2～4 字的规则。按游戏的词面/已审别名所属概念排除歧义题，重复别名不会把一个概念误算成多个。

默认请求低思考强度与 JSON 对象模式，给思考和正文共同留出输出预算；低思考不等于关闭思考，上游拒绝 JSON 模式时会明确回退。默认每批 10 道、最多 30 次，可用 `--batch-size`（1～20）及 `--max-calls`（1～100）控制费用。漏题或不合格提示每次运行最多尝试 3 次；JSON 不完整会缩小批量，达到上限仍保留未完成清单，不把缺额当成完成。网络/额度错误保留前面已保存的候选并停止，不换密钥或重置额度。同一审核文件再次运行会跳过已经待审/通过且与原题仍匹配的提示。没有候选时不读取凭据或请求模型。

审核文件中这些条目有 `action: "update_hint"`。可以人工将合格项改为 `status: "approved"` 后执行 `publish`，或将同一个 `--base`、`--review` 交给下述独立审核脚本。已审提示改了文字必须重新审核，不能沿用旧模型批准；同一道旧题的重复补提示会被拒绝。提示不能包含单字答案或单字别名。如果原提示已被别人改动，发布跳过以防覆盖。生成、审核、发布时都可加同一份 `--blocklist`。

### 一次性批量审核并导入

运行 [`tools/dictionary_audit.py`](../tools/dictionary_audit.py) 不需要逐条手改审核文件。默认使用 `deepseek-v4.1-flash`（用户所称 deepseekv4.1f 在当前模型列表中的完整 ID），逐批审核**所有**待审题目、提示与相关词。每一条必须得到明确的通过/拒绝决定；本地再次检查格式、敏感片段、字数、词面重复和答案依赖。模型可能误放行过于具体的提示，因此自动审核**先把首阶段提示收紧成宽泛类别或人工整理的安全方向**，再让模型核对题目、提示和相关词；原提示保留在审核记录供追溯。对已确认因提示与分类不匹配而误拒的词，可纠正一次并重新审核，不会重试安全内容拒绝。每批保存结果；模型接口失败时立即停下，未审核条目绝不作为通过，重跑会继续处理剩余条目。通过的内容合并为**完整包**并自动导入本机抖音后台题库，导入后**不会自动切换正在直播的游戏词库**。

```cmd
python "E:\项目内容\Tik Tok直播测试游戏\tools\dictionary_audit.py"
```

当前私有配置是公网 HTTP，交互运行时会再次询问是否接受明文传输 API Key；只有输入 `yes` 才继续。自动化运行须明确加 `--allow-insecure-http`，但更推荐换成 HTTPS。若后台尚未启动，审核包仍会保存，后台可用时用同一命令重试导入，不会重新审核已完成的条目。只想生成包、不导入则加 `--no-import`。审核决策、理由、模型 ID 保存在 Git 忽略的 `data/dictionary-proposals/zh-review.json`；可查看生成的 `zh-audited-日期-指纹.json`，必要时在实际切换游戏词库前抽样复核。模型审核有漏判风险，不能等同平台合规背书。

若选择手工审核，也可逐项查看 `data/dictionary-proposals/zh-review.json`：确认词条合规、字数正确、含义稳定、提示不会立刻暴露答案；仅将认可条目的 `status` 从 `pending` 改为 `approved`，不合适的改为 `rejected`。然后手工发布**整包**：

```powershell
python tools/dictionary_builder.py publish --base data/dictionaries/multilingual_core_v1.json --review data/dictionary-proposals/zh-review.json --output data/dictionary-proposals/zh-live-v1.json
```

在抖音运营后台“游戏设置 → 词库包管理”导入 `zh-live-v1.json`，选择该包，语言设为中文并保存。保存设置会重开一局；请在合适时机执行。不要直接覆盖或修改运行中的内置词典。
本次代码将词典包导入上限提高到 **10 MB**（礼物目录仍为 1.5 MB）。如果运营后台仍提示旧的 1.5 MB 限制，需要在合适时机重新构建并重启抖音服务，不能在当前真实直播采集期间贸然替换进程。

下一次增量，以**上一次发布的整包**为 `--base`，继续使用或另建审核文件，发布到一个新文件名；已存在的词会被跳过。发布默认拒绝覆盖现有输出，需要明确 `--overwrite` 才覆盖，以免误丢已审核内容。`data/dictionary-proposals/` 已被 Git 忽略；如需长期备份，请自行保留这些审核和发布文件。

## 独立补旧题词性（不重跑提示）

`tools/dictionary_metadata.py`只补基础包中未标注词性的已有中文题目，支持1～4字；不会把所有题目默认成名词。生成固定用hy3，独立审核用deepseek-v4.1-flash，不能用生成模型自己批准。拒绝或兼类/无法确定的项目保留待人工处理，不自动重审放行。现有词性不覆盖，跨概念别名歧义题不处理；可以用`--skip-words 餐食`跳过已有待决定项，这只是跳过补标注，不是停用正式题目。

先使用`plan`查看范围，不读取模型凭据或发起请求。将`基础完整包.json`替换为准备继续增量的包；同一轮生成、审核、发布必须使用同一个基础包和审核文件。

```cmd
python "E:\项目内容\Tik Tok直播测试游戏\tools\dictionary_metadata.py" plan --base "基础完整包.json" --review "词性审核.json" --skip-words 餐食
python "E:\项目内容\Tik Tok直播测试游戏\tools\dictionary_metadata.py" generate --base "基础完整包.json" --review "词性审核.json" --skip-words 餐食 --allow-insecure-http
python "E:\项目内容\Tik Tok直播测试游戏\tools\dictionary_metadata.py" audit --base "基础完整包.json" --review "词性审核.json" --skip-words 餐食 --allow-insecure-http
python "E:\项目内容\Tik Tok直播测试游戏\tools\dictionary_metadata.py" publish --base "基础完整包.json" --review "词性审核.json" --skip-words 餐食 --output "新的备用包.json"
```

模型地址/密钥只从现有本机私有配置读取；公网HTTP仍须明确传`--allow-insecure-http`，该选项不是加密。每批默认12项、最多30个逻辑批请求；可用`--batch-size`（1～20）、`--max-calls`（1～100）和`--timeout`（0～180秒、不含0）限制。共享请求器每个逻辑请求最多尝试3次HTTP，因而逻辑批数不是实际HTTP调用数。格式漏项会有界拆批，额度/网络错误保存进度后停止，不使用额度重置卡、换密钥或升级套餐。

再次运行同一审核文件不会重复生成已有候选或重新审核有效的已批准指纹。基础包变化不能沿用旧批准；候选词性/依据变化后必须重新独立审核。**还有pending时不允许发布**；rejected和unresolved不会写入新包，也不代表已解决。发布只输出新文件，拒绝覆盖基础包、审核记录或已有输出；它不导入后台、不激活包、不重启服务。若要使用，仍需人工在后台导入并在合适时机明确选择。模型词性审核不等于专业语言学审核或评分质量已通过。

该流程不修改答案、别名、相关词、提示、游戏规则或Embedding输入。候选/审核结果和诊断应放在Git忽略的`data/dictionary-proposals/`中，留存真实通过/拒绝与待确定数量，不能只看脚本退出0。

2026-10-04实测见 `dictionary-metadata-verification-2026-10-04.md`：77项词性经独立审核后已导入新的备用包，20项兼类未确定、“餐食”1项跳过，未激活。入库核对另修复了加载时反复添加相同别名的问题；仅去掉完整字段相同的副本，保留审核状态和来源差异，不覆盖已有包。

## 可选：最近热点作为取词素材

脚本**不会凭模型记忆虚构“最新热点”**。若要用近期内容，准备 UTF-8 JSON 数组，包含真实来源、标题和带时区的发布时间；只收 14 天内的标题。示例结构（占位文本，不代表真实新闻）：

```json
[
  {"title":"在这里填入已核实的近期标题","source":"在这里填入来源","publishedAt":"2026-09-23T09:00:00+08:00"}
]
```

调用时加 `--topics-file 热点标题.json`。标题被标记为**不可信数据**，只作为通用概念的灵感；不得让标题中的命令改变生成规则，也不复制新闻正文、人物姓名或事件名称。正式发布前人工检查时效、侵权与平台合规风险。
审核文件会保留这批标题的来源、时间和 `topicContextId`，方便回看生成时参考了哪些素材；这**不代表**某个候选词确实出自某篇报道。

## 安全与实际限制

首阶段方向提示与语义释义不是同一用途：自动审核会保留宽泛提示以免一眼猜中，不应把这种模板直接当Embedding的精确义项。抖音中文评分只使用当前词典中较具体的已审定义，缺失或类别模板仍用裸词。实际运行包207题当前13具体、101模板、93缺提示；小样本排序改进不代表全库校准。只读真实向量对照入口为 `node tools/verify-semantic-quality.mjs --package 词库包ID`，结果写入Git忽略的 `.runtime/semantic-quality/`，不改直播或词库。详见 `semantic-context-verification-2026-10-04.md`。

2026-10-04后续补齐结果见 `dictionary-hints-verification-2026-10-04.md`：92项方向提示已独立审核通过并导入备用包，1项“餐食”拒绝待处置；未自动切换正式词库。旧题缺词性时传未标注值，不编造“名词”；若审核拒绝源于安全、歧义或词面质量，不自动按提示问题反复重试。

- 生成阶段是离线流程；自动审核会请求指定 AI 接口并调用本机抖音后台的题库导入接口，但不会重启服务、切换正在直播的词库或发送礼物。
- 只有标为 `approved` 且再次通过本地检查的词条进入发布包；可由第二模型审批，也可由人审批。
- 本地敏感片段表只是低成本拦截，不能替代专业内容审核；政治、医疗、色情、暴力、版权、歧义和文化差异须人工把关。
- 可准备每行一项的私有禁词文本，生成和发布时都传 `--blocklist 路径`。该文件不应提交到仓库；它也不能替代人工审核。
- 题目提示在发布时必须再次检查；已有库里的旧题目不由本脚本自动重写。
- 若密钥曾发在聊天里，应在服务提供方撤销并更换后再投入长期使用。

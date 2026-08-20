# fixture 02_models（着席解決の再現用。正本は dotagents docs/02_models.md）

## 順位表（役割→1位〜3位）

| 役割 | 1位 | 2位 | 3位 |
|---|---|---|---|
| 統括 | **オーナー指定** | — | — |
| 反証 | Grok 4.6×high | Sol×high | Opus 5×high |
| 監査・発見 | Grok 4.6×medium | Sonnet 5×medium | Terra×medium |
| 設計 | Opus 5×high | Grok 4.6×high | Sol×medium |
| 相談 | ChatGPT（gpt-connector） | Grok 4.6×medium | Fable 5×high |
| 実装 | Terra×high | Sonnet 5×medium | Grok 4.6×medium |
| 局所コーディング | Luna×medium | Sonnet 5×medium | Grok 4.6×medium |
| 軽作業 | Luna×low〜medium | Haiku（effortなし） | Grok 4.6×low |
| 調査 | Grok 4.6×low | Sonnet 5×medium | Sol×medium |

## モデル台帳（slug・価格の解決はここだけ）

| モデル | slug | API定価（入力/出力 per Mtok） | context | effort段階 |
|---|---|---|---|---|
| Claude Fable 5 | alias `fable` | x | x | x |
| Claude Opus 5 | alias `opus` | x | x | x |
| Claude Sonnet 5 | alias `sonnet` | x | x | x |
| Claude Haiku 4.5 | alias `haiku` | x | x | x |
| GPT-5.6 Sol | `gpt-5.6-sol` | x | x | x |
| GPT-5.6 Terra | `gpt-5.6-terra` | x | x | x |
| GPT-5.6 Luna | `gpt-5.6-luna` | x | x | x |
| Grok 4.6 | `grok-4.6` | x | x | x |

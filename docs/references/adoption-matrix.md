# Reference adoption matrix

| Reference pattern                                                      | Classification     | AgentFlow decision                                                                                     |
| ---------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| Conversation-first navigation                                          | ADOPT BEHAVIOR     | The existing AgentFlow workspace uses a persistent composer and conversation timeline.                 |
| Provider/model selection affordance                                    | ADOPT BEHAVIOR     | Selection is represented by separate adapter, provider, model, profile, role, and permission concepts. |
| Grouped tool activity                                                  | ADOPT BEHAVIOR     | Adapter events are normalized into grouped workflow events while preserving redacted raw payloads.     |
| Stop / retry / resume interaction                                      | ADAPT PATTERN      | Cancellation and native-session identifiers belong to the AgentAdapter SDK and AgentRun state machine. |
| Timeline virtualization                                                | ADAPT PATTERN      | The UI boundary will consume paginated projections; no reference implementation was copied.            |
| T3 Code source, schema, package layout, IPC, or provider session model | REJECT             | AgentFlow has its own domain and package boundaries.                                                   |
| External source code                                                   | PORT ISOLATED CODE | None used in this repository.                                                                          |

No material external code has been reused. If that changes, the source, license, isolated files, and modifications must be recorded here and in `THIRD_PARTY_NOTICES.md` before merge.

/**
 * Server instructions: MCP clients put this text into every session's system prompt, so details live in memory_guide.
 */
export const INSTRUCTIONS = `Local Memory: persistent memory in a local SQLite file.

EVERY CONVERSATION:
1. memory_session_start({project}) first: returns headlines and ids.
2. memory_get({ids}) for the full text of the entries you need.
3. memory_search (hybrid) or memory_recall (keywords, learnings only) to find more.
4. memory_learn stores a finding, memory_learn_update amends one, memory_decide records a decision.
5. memory_session_end({summary}) at the end.

Everything else: memory_guide().`;

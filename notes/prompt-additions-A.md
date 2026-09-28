# System prompt additions — Workstream A (compaction)

Workstream A did not edit the system prompt string in `src/agent.ts`. Proposed addition, to merge at integration (one sentence, after the note-taking sentence):

> A "[Harness status]" message lists the project files known from your listings and which ones you have not read yet. Use it instead of listing the files again, and if you leave files unread, name them in your final answer.

Why: the status block is attached to every request (it is not stored in history), and the model otherwise has no instruction on how to treat it. In the eval runs the model already used it without this sentence (reads followed the unread list), so this is a clarity improvement, not a fix.

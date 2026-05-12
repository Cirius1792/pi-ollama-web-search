# PRD: Local-First Context-Safe Ollama Web Workflow

## Problem Statement

The extension currently exposes Ollama web search and fetch capabilities to pi, but its default behavior and documentation are still oriented toward a general-purpose usage model rather than the specific needs of local models with small context windows.

For users running local models, web results can consume context too aggressively even when truncation is available. The extension already offers truncation, follow-up retrieval, and file-based export for large fetch results, but these capabilities are not yet framed as part of a deliberate local-first workflow. In addition, the truncation budget is fixed in code rather than configurable per installation or per model, which makes it hard to tune the tools for mixed environments where different models have different context budgets.

The result is a mismatch between the package's current implementation surface and the workflow it should support: keeping default tool output compact, preserving context for reasoning, and enabling selective or out-of-band analysis of larger resources when needed.

## Solution

Reposition the extension as a local-first package for context-safe web search and retrieval in pi.

The package should keep `ollama_web_search` and `ollama_web_fetch` safe by default for small-context models, while preserving the current targeted retrieval model through `ollama_web_read_full`. The main product change is the introduction of a dedicated extension configuration file that defines a context budget profile with conservative defaults and optional model-specific overrides.

The package should automatically create a global configuration file when missing, apply a local-first default profile out of the box, resolve the active profile from the current model at tool-call time, and expose the applied settings in tool details. Search guidance and README positioning should be updated so that the default workflow is clearly: discover relevant pages with compact output first, then selectively retrieve more only when needed, including export to file for large resources.

This work should enable users to adopt workflows such as file-based inspection, delegated summarization, or other out-of-band analysis approaches without the extension having to implement those orchestration techniques directly.

## User Stories

1. As a pi user running a local model with a small context window, I want web search results to default to compact output, so that the tool does not overwhelm my model's available context.
2. As a pi user running a local model with a small context window, I want fetched pages to be truncated conservatively by default, so that I can inspect pages without sacrificing too much reasoning space.
3. As a pi user, I want the extension to describe itself as local-first, so that I immediately understand the intended workflow and trade-offs.
4. As a pi user, I want the extension to document selective follow-up retrieval, so that I know how to inspect large resources without loading everything into the model context.
5. As a pi user, I want the extension to support file export for large fetched content, so that I can inspect or analyze it outside the main model context.
6. As a pi user, I want conservative defaults to be applied automatically after installation, so that I get a context-safe experience without extra setup.
7. As a pi user, I want the extension to create its global config file automatically when missing, so that I can discover and edit the available settings easily.
8. As a pi user, I want configuration to live in a dedicated extension file, so that it is easy to find and manage separately from other pi settings.
9. As a pi user, I want project-level configuration to override my global defaults, so that a repository can define a shared context-safe policy when needed.
10. As a pi user, I want the project config file to be suitable for committing to the repository, so that teams can share a common search and fetch budget policy.
11. As a pi user switching between models, I want the extension to resolve limits from the active model, so that local and larger-context models can use different budgets automatically.
12. As a pi user, I want model-specific configuration to match exact model identifiers, so that I can tune individual models precisely.
13. As a pi user, I want model-specific configuration to support simple glob patterns, so that I can define shared policies for model families without repeating entries.
14. As a pi user, I want the most specific matching pattern to win, so that fallback rules and model-family rules can coexist predictably.
15. As a pi user, I want the extension to expose the applied profile in tool metadata, so that I can understand which rule produced the active limits.
16. As a pi user, I want search result count to be configurable alongside output length, so that I can trade off breadth and depth for small-context models.
17. As a pi user, I want search output to prioritize depth over breadth, so that the few results I do see are informative enough to guide the next step.
18. As a pi user, I want existing `ollama_web_read_full` behavior preserved for now, so that follow-up retrieval workflows do not change unexpectedly.
19. As a pi user, I want fetch file export to remain available only for fetched resources, so that the search-vs-fetch mental model stays simple.
20. As a pi user, I want warnings for invalid configuration to be non-blocking, so that the tools remain usable even when setup is imperfect.
21. As a pi user, I want invalid configuration files to fall back to safe defaults, so that a typo does not accidentally remove context protection.
22. As a pi user, I want missing model matches to quietly use the default profile, so that I do not get noisy warnings during normal operation.
23. As a pi user, I want a warning when the current model cannot be determined, so that I know the default profile was used instead of a model-specific one.
24. As a pi user, I want legacy or older config files to keep working when structurally valid, so that upgrades do not force immediate migration.
25. As a maintainer, I want the README to explain the local-first workflow clearly, so that users understand why the extension truncates and when to retrieve more.
26. As a maintainer, I want the package metadata and release positioning to reflect a major product shift, so that the `1.0.0` release communicates the new default philosophy clearly.

## Implementation Decisions

- The extension will be repositioned as a local-first package for small-context models, with context preservation as the primary workflow principle.
- The primary production tools remain unchanged: `ollama_web_search`, `ollama_web_fetch`, and `ollama_web_read_full`.
- `ollama_web_search` and `ollama_web_fetch` will become configuration-driven for both output length and search result count.
- `ollama_web_read_full` behavior will remain unchanged for this phase.
- File export remains available only for fetched resources, preserving the current distinction between search as discovery and fetch as resource retrieval.
- Search result presentation remains depth-first: fewer, more useful visible results are preferred over guaranteeing a snippet for every result.
- The extension will introduce a dedicated configuration file named `pi-ollama-web-search.json`.
- The global configuration file lives in pi's effective config directory and must respect the active pi config root rather than assuming a hard-coded home-directory path.
- The project override file lives under the repository's `.pi` directory.
- If the global configuration file is missing, the extension will create it automatically with local-first defaults.
- Global and project configuration will merge, with project values overriding global values.
- The configuration schema will include a top-level version string tied to the extension's major and minor version.
- A major-version mismatch between extension and config should produce a warning, but structurally valid config should still be used.
- A config file without a version field should be treated as legacy but still accepted when structurally valid.
- The initial default profile will be conservative and local-first:
  - `maxOutputChars = 12000`
  - `maxResults = 3`
- Model-aware configuration will resolve using the canonical model key format `provider/id`.
- Model overrides will support exact matches and simple glob-pattern matches.
- Match precedence is `exact > pattern > default`.
- When multiple patterns match, the most specific pattern wins.
- Model overrides will be complete profiles rather than partial overlays, to keep implementation and validation simple.
- The same active profile should determine both output truncation behavior and the retrieval recommendation threshold.
- The active profile is resolved at tool-call time using the model active at that moment.
- If the active model cannot be determined, the extension will use the default profile and emit a warning.
- The tool response details for search and fetch should include the applied values and their origin, including the winning rule when applicable.
- Warning behavior should remain non-blocking and UI-oriented rather than changing the main tool text.
- Prompt guidance for the tools should explicitly encourage a context-safe workflow: compact discovery first, then selective retrieval or file-based inspection when needed.
- The README should combine a clear local-first positioning statement with concrete but non-claiming examples of enabled workflows such as file-based inspection, delegated summarization, and targeted follow-up extraction.
- This change set will be released as version `1.0.0`.
- The package and repository names remain unchanged.

## Testing Decisions

- Good tests should verify externally visible behavior and metadata contracts rather than internal implementation details.
- Configuration loading and resolution should be tested for creation of the default global file, global/project merge behavior, exact and pattern matching, pattern specificity, legacy config acceptance, invalid config fallback, version warnings, and model-unavailable fallback behavior.
- Search behavior should be tested for application of configured `maxOutputChars` and `maxResults`, continued depth-first truncation behavior, and the presence of applied-profile metadata in tool details.
- Fetch behavior should be tested for application of configured `maxOutputChars`, continued retrieval metadata behavior, and applied-profile metadata in tool details.
- Retrieval behavior should be regression-tested to confirm that `ollama_web_read_full` remains unchanged in this phase.
- Extension registration and session lifecycle tests should be expanded to cover config file creation, warnings, and tool detail exposure.
- README-facing behavior should be reflected indirectly through prompt-guideline tests where the extension exposes new local-first instructions.
- Existing test styles in the codebase already provide prior art for this work: isolated unit tests for search/fetch/format/normalization/retrieval behavior and integration-style extension tests for registration, details payloads, and lifecycle behavior.

## Out of Scope

- Adding new production tools beyond the current search, fetch, and read-full set.
- Implementing explicit orchestration for subagents, recursive language models, summarization pipelines, or file-analysis workflows.
- Changing `ollama_web_read_full` inline defaults or adding new safeguards there.
- Adding file export support for search refs.
- Introducing environment-variable overrides for the new context profile settings.
- Adding a persistent footer or status-line UI for the active profile.
- Automatically rewriting or migrating existing configuration files.
- Renaming the package or repository.

## Further Notes

- The configuration section in repository documentation must explicitly state that model overrides are complete profiles and not partial patches.
- The README should make the local-first workflow obvious without over-claiming support for downstream analysis techniques the extension does not implement itself.
- Because this release intentionally changes default behavior in a more conservative direction, release notes should frame the change as a deliberate product shift rather than a minor tuning adjustment.

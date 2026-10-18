# Claude Code — Start Harmonia implementation

Read `Harmonia_Product_Spec.md` completely before coding. Treat it as the source of truth. Inspect the current repository and development environment, preserve unrelated work, and then execute the implementation phases in the specification in order.

Do not ask routine clarification questions. The specification contains the product decisions and default behaviours. Make reasonable small decisions, document them, and continue. Do not stop after writing a plan. Implement the app in runnable, testable vertical slices; run tests, lint, type checks, and builds whenever the current environment supports them.

If a platform cannot be compiled or signed in the current environment (for example, iOS/watchOS without macOS/Xcode), continue implementing and validating all work that is possible, document the exact blocker and required manual verification, and continue other phases. Never claim a build or device test passed unless it actually ran.

Begin with repository/toolchain inspection, update/create `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, and `README.md`, then start implementing Phase 1 and keep progressing through the specification until all feasible work is complete.

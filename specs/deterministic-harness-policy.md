# Deterministic Harness Policy

## overview
The deterministic harness governs workflow discipline separately from semantic build trust. It requires approved verifier commands and evidence before completion.

## verifier-commands
The harness must accept `verify:local` and `verify:release` as the required implementation and release verification commands, and it must block completion when those verifiers are missing or when evidence is incomplete.

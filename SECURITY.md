# Security policy

Please do not report security vulnerabilities in public issues.

For a vulnerability involving Speak, use GitHub's private vulnerability reporting for this repository when available. Include the affected component, reproduction steps, impact, and any suggested remediation.

Never include live API keys, phone credentials, customer/contact data, recordings, message contents, or production configuration in a report. Redact sensitive values and use synthetic examples.

The project treats provider secrets as backend-only, verifies supported webhook signatures, and requires proof-backed completion for live-world actions. A security report that shows a bypass of those boundaries is especially useful.

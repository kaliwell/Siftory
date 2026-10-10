# Siftory（寻藏）Security, Update, and Support Policy Template

> **DRAFT — NOT FOR DISTRIBUTION**
>
> This template records engineering decisions still required from the actual publisher. It is not a
> support promise, security SLA, or approved update policy.

## Required publisher information

- Publisher/legal entity: `{{PUBLISHER_LEGAL_NAME}}`
- Security reporting channel: `{{SECURITY_CONTACT}}`
- Customer support channel and hours: `{{SUPPORT_CONTACT_AND_HOURS}}`
- Supported sales channels and territories: `{{CHANNELS_AND_TERRITORIES}}`
- Policy effective date/version: `{{EFFECTIVE_DATE}}` / `{{POLICY_VERSION}}`

## Current engineering baseline

1. Siftory（寻藏） currently uses manual installer upgrades. Automatic update is not implemented and
   must not be advertised.
2. Online and offline installers share the same application identity and user-data directory.
3. Uninstall keeps application data by design; users must be told how to export and remove retained
   data.
4. Release artifacts are expected to carry a valid Authenticode signature, SHA-256 digest, SBOM and
   commit-bound release record.
5. Runtime and model artifacts are pinned by size and SHA-256. Unverified downloads fail closed.
6. Security fixes must pass the same online/offline and Chinese/English packaged matrix as normal
   releases unless an authorized emergency procedure documents a narrower, time-bounded exception.

## Decisions required for the final policy

- Supported Windows versions, architectures and hardware requirements.
- Stable/beta update channels and whether updates are manual, in-app or Store-managed.
- Support lifetime per major release and minimum notice before end of support.
- Security acknowledgement target, remediation target and coordinated disclosure process.
- Rollback availability, migration compatibility and retention of previous signed installers.
- Rules for revoked certificates, compromised artifacts and emergency release communication.
- Scope of free support, paid support, refunds and service availability.

## Release checklist

- [ ] Real security and support contacts are monitored.
- [ ] Supported platforms and lifecycle dates match the shipped build.
- [ ] Update and rollback claims have packaged tests and signed fixtures.
- [ ] Vulnerability intake, severity triage and customer notification owners are assigned.
- [ ] All placeholders are replaced and the file is renamed to
      `legal/SECURITY_AND_SUPPORT_POLICY.md`.
- [ ] The final document contains no draft marker and has authorized approval evidence.

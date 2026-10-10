# Siftory（寻藏）Privacy Policy Template

> **DRAFT — NOT FOR DISTRIBUTION**
>
> This is an engineering data inventory and drafting aid. It is not an approved privacy policy.
> Every placeholder and jurisdiction-dependent term must be completed by the actual publisher and
> reviewed before a final `legal/PRIVACY_POLICY.md` is created.

## Required publisher information

- Publisher/legal entity: `{{PUBLISHER_LEGAL_NAME}}`
- Privacy contact: `{{PRIVACY_CONTACT}}`
- Effective date and version: `{{EFFECTIVE_DATE}}` / `{{POLICY_VERSION}}`
- Sales territories and applicable law: `{{TERRITORIES_AND_APPLICABLE_LAW}}`
- Final policy URL or bundled location: `{{POLICY_LOCATION}}`

## Current engineering data inventory

| Data | Current purpose and location | Network behavior | Retention/deletion control |
| --- | --- | --- | --- |
| Settings and window layout | Local application data | None by default | Reset settings or remove retained application data |
| Original media paths and metadata | Local search catalog; original files remain user-owned | Remote paths are contacted only for user-configured sources | Remove a source or derived catalog; original media is not deleted by index cleanup |
| Thumbnails, hashes, embeddings and search indexes | Local derived search data | None by default | Preview and clear derived data in the application |
| Face/person features and subject masks | Local derived search features | None by default | Clear the related derived index and user models |
| Video frames, transcripts, speaker segments and semantic summaries | Local derived media-search data | External runtimes are used only when explicitly configured | Clear Media Search derived data; original videos remain intact |
| SSH/SFTP profiles | Local profile store; credentials use operating-system protected storage | Connects only to user-configured hosts | Delete the profile and stored credential |
| Runtime/model downloads | Local verified resource cache | Contacts the selected upstream only after the relevant user and license flow permits it | Remove the downloaded runtime/model cache when not in use |
| Diagnostic logs | Local bounded and redacted logs | No automatic upload is currently promised | Clear diagnostic data from application storage |

## Required final-policy decisions

1. State whether telemetry, crash reports, update checks or cloud AI are shipped in the selected
   release profile. Do not describe planned behavior as implemented behavior.
2. Explain purposes, legal bases or consent flows, retention, deletion, export, complaint and
   withdrawal rights for the actual territories.
3. Explain treatment of biometric, voice, transcript, credential and remote-source information.
4. Identify every recipient or network endpoint that receives personal information, if any.
5. Explain cross-border transfers and processors only when they actually exist.
6. State the age/child policy and any mandatory sensitive-information protections.
7. Keep this policy version synchronized with the EULA acceptance and shipped application version.

## Release checklist

- [ ] Publisher identity and privacy contact are real and verified.
- [ ] The inventory matches the final online and offline builds.
- [ ] All placeholders are replaced and the file is renamed to `legal/PRIVACY_POLICY.md`.
- [ ] The final document contains no draft marker.
- [ ] Required in-app notices and consent controls are verified in both languages.
- [ ] An authorized reviewer records the policy version and evidence.

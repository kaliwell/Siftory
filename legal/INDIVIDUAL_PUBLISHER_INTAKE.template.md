# Siftory（寻藏）Individual Publisher Intake Template

> **DRAFT — NOT FOR DISTRIBUTION**
>
> Individual publisher mode was selected on 2026-08-17. This template separates public release
> metadata from sensitive identity records. Do not commit government ID numbers, tax identifiers,
> bank details, a private residential address, certificate private keys or scans of identity
> documents to this repository.

## Public release fields

- Public publisher/display name: `{{PUBLIC_PUBLISHER_NAME}}`
- Public legal/privacy contact: `{{PUBLIC_LEGAL_CONTACT}}`
- Public security/support contact: `{{PUBLIC_SECURITY_SUPPORT_CONTACT}}`
- Country or region shown to customers: `{{PUBLIC_COUNTRY_OR_REGION}}`
- Initial sales territories: `{{RELEASE_TERRITORIES}}`
- Sales channel or merchant of record: `{{SALES_CHANNEL}}`
- Product name and version: `{{PRODUCT_NAME_AND_VERSION}}`
- Authenticode certificate subject/publisher: `{{SIGNING_IDENTITY}}`
- Governing law and dispute venue after review: `{{GOVERNING_LAW_AND_VENUE}}`
- Refund, trial, device and transfer terms: `{{COMMERCIAL_TERMS}}`

## Secure off-repository evidence

The following records may be required by a certificate provider, Store, payment provider, tax
authority or legal reviewer. Keep them in an access-controlled location outside Git and reference
them only with a non-sensitive record ID.

- Verified legal identity and age/authority evidence.
- Residential or service address required by the selected channel.
- Tax registration and invoice records.
- Payment and bank settlement records.
- Code-signing identity-validation evidence and private-key custody procedure.
- Legal-review record for the EULA, privacy policy and support policy.

Opaque evidence reference for the repository decision record:
`{{SECURE_IDENTITY_EVIDENCE_REFERENCE}}`.

## Completion checklist

- [ ] Public publisher and contact fields are safe to publish and actively monitored.
- [ ] Sensitive identity records are stored outside the repository.
- [ ] Sales territories, payment/refund rules and governing law have real review.
- [ ] The signing identity matches the approved publisher identity.
- [ ] Final EULA, privacy and support documents use the same public publisher information.
- [ ] `legal/commercial-release-decisions.json` contains approval metadata and only an opaque
      external evidence reference.

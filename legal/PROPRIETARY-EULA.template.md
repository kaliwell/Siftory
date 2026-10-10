# Siftory（寻藏）Proprietary EULA Template

> **DRAFT — NOT FOR DISTRIBUTION**
>
> This file is an engineering template, not an effective license and not legal approval. It must
> not be copied into an installer or presented to users until every placeholder is replaced and an
> authorized legal review approves the final text.

## Required completion data

- Copyright holder: `{{RIGHTSHOLDER_LEGAL_NAME}}`
- Product/legal entity address: `{{RIGHTSHOLDER_ADDRESS}}`
- Legal contact: `{{LEGAL_CONTACT_EMAIL}}`
- Effective date and document version: `{{EFFECTIVE_DATE}}` / `{{EULA_VERSION}}`
- Sales channels and territories: `{{AUTHORIZED_SALES_CHANNELS_AND_TERRITORIES}}`
- License scope, device/user count and transfer rules: `{{LICENSE_SCOPE}}`
- Refund and subscription terms: `{{PAYMENT_AND_REFUND_TERMS}}`
- Privacy policy location: `{{PRIVACY_POLICY_LOCATION}}`
- Governing law and dispute venue: `{{GOVERNING_LAW}}` / `{{DISPUTE_VENUE}}`
- Mandatory consumer-rights exceptions: `{{MANDATORY_CONSUMER_RIGHTS}}`
- Liability cap and exclusions approved for the selected jurisdictions: `{{LIABILITY_TERMS}}`

## End User License Agreement skeleton

This End User License Agreement (“Agreement”) is between `{{RIGHTSHOLDER_LEGAL_NAME}}`
(“Licensor”) and the person or organization installing or using Siftory（寻藏） (“User”). By the
acceptance mechanism approved for the selected sales channel, User agrees to the final version of
this Agreement.

### 1. License grant

Subject to payment, this Agreement and applicable mandatory law, Licensor grants User a limited,
non-exclusive, non-transferable and revocable license described by `{{LICENSE_SCOPE}}`. This
proprietary grant does not transfer trademark or ownership rights, or require delivery of
Siftory's proprietary application source. Third-party source, license and modification rights
remain governed by section 3 and are not restricted by this paragraph.

### 2. Restrictions

The final agreement must state the permitted and prohibited copying, resale, sublicensing,
distribution, reverse engineering and circumvention rules, including every exception required by
applicable law: `{{LICENSE_RESTRICTIONS_AND_EXCEPTIONS}}`.

### 3. User-supplied models and third-party components

Siftory（寻藏） does not grant rights to user-supplied ONNX models. Users must obtain and comply with
the applicable model, weight, dataset and deployment terms. Third-party components distributed with
the application remain governed by their own notices and license texts; this Agreement does not
replace or restrict rights granted by those licenses.

Where LGPL 2.1 section 6 applies to a work combining this application with a covered library,
Users may modify that work for their own use and reverse engineer it to debug those modifications
to the extent required by that section. This exception takes precedence over conflicting
restrictions elsewhere in this Agreement. Users retain the applicable rights to replace compatible shared
libraries or use the relinking materials supplied with the distribution. Product loading,
integrity and installation mechanisms must implement the selected compliant mechanism; this
paragraph alone is not evidence that replacement or relinking works.

For MPL-covered files, their source remains available under the MPL. Terms for Siftory's executable
must not limit or alter recipients' rights in that source. The final distribution must identify a
working way to obtain the covered source and its notices; an incomplete source offer or this
template does not satisfy that requirement.

For the specifically identified Windows SDK distributable files, incorporate reviewed downstream
protection terms and the applicable original texts. Limit those restrictions to the covered SDK
files; do not apply them indiscriminately to LGPL/MPL or other independently licensed components.
The Chinese review draft is `SDK-END-USER-TERMS.template.zh-CN.md`. It is not final text or an
acceptance record. The final release must require an explicit user choice before application use,
retain the accepted document version and digest locally, and present changed terms for a new choice.
Opening the third-party-license directory does not by itself implement this requirement.

### 4. Data and privacy

Describe local processing, optional network functions, diagnostics, retention and deletion based on
the shipped build and the final privacy review: `{{DATA_PROCESSING_AND_PRIVACY_TERMS}}`.

### 5. Updates, support and availability

State update eligibility, support scope, service availability and end-of-support policy:
`{{UPDATE_AND_SUPPORT_TERMS}}`.

### 6. Payment, cancellation and refunds

The final terms must match each sales platform and all mandatory consumer protections:
`{{PAYMENT_AND_REFUND_TERMS}}` and `{{MANDATORY_CONSUMER_RIGHTS}}`.

### 7. Warranty and liability

Insert only limitations reviewed for the actual territories. They must not exclude rights or
liabilities that cannot legally be excluded: `{{WARRANTY_TERMS}}` and `{{LIABILITY_TERMS}}`.

### 8. Termination

Define termination triggers, notice, cure periods where applicable, and what the User must do after
termination: `{{TERMINATION_TERMS}}`.

### 9. Governing law and disputes

This Agreement is governed by `{{GOVERNING_LAW}}`, subject to mandatory local protections. The
approved dispute process and venue are `{{DISPUTE_PROCESS}}` and `{{DISPUTE_VENUE}}`.

### 10. Contact and complete agreement

Legal notices must be sent to `{{LEGAL_CONTACT_EMAIL}}` at `{{RIGHTSHOLDER_ADDRESS}}`. The final
agreement must identify incorporated policies, order-of-precedence rules, severability, waiver,
assignment and language precedence: `{{BOILERPLATE_TERMS}}`.

## Release checklist

- [ ] All placeholders are replaced with reviewed values.
- [ ] The copyright holder and authority to license the project are verified.
- [ ] Consumer, privacy, refund and governing-law terms match every sales territory.
- [ ] Third-party notices and required license/source-offer materials match the packaged inventory.
- [ ] LGPL library replacement or relinking is verified, and the final restrictions retain the required modification/debugging exceptions.
- [ ] Recipients can obtain the MPL-covered source through the actual documented delivery method.
- [ ] The acceptance flow records the EULA version without collecting unnecessary personal data.
- [ ] The final file is renamed without `DRAFT` or `template` in its path.
- [ ] `legal/license-decisions.json` points to the final file and contains real approval evidence.
- [ ] The online/offline license gate and installer archive smoke both pass.

# Implementation Plan: Raffle Platform

## Overview

The implementation language is TypeScript (Node.js backend, Next.js PWA front end), as set in the design. Work starts with foundations (project, schema, money/time utilities, scheduler, audit), then builds the pure domain cores with their adapters module by module (auth, raffle, inventory, payments, draw, notifications, compliance, fraud), then the back office, analytics, share page, privacy, and the PWA client. The last task wires everything together. Property tests use fast-check with Vitest (at least 100 runs each) and carry the tag `Feature: raffle-platform, Property N: ...`.

## Tasks

- [x] 1. Foundations: project, schema, utilities, scheduler
  - [x] 1.1 Scaffold the project and shared types
    - Create the TypeScript workspace (backend modules, Next.js client, shared package), Vitest, fast-check, lint and format config
    - Define shared types: `Money` (bigint minor units plus currency), `Locale`, `Country`, `Result<T,E>`, `FieldError`, clock and RNG interfaces for injection
    - _Requirements: 2.5, 20.5, 25.6_

  - [x] 1.2 Create the PostgreSQL schema and migrations
    - Tables: user, raffle, ticket (unique `(raffle_id, number)`, status check constraint), order, payment (unique `(provider, provider_reference)`), refund, draw, payout, audit_event, notification, ruleset_version, kyc_record, support_case, job
    - Money columns as bigint minor units; no card data columns
    - _Requirements: 4.1, 4.2, 5.9, 6.3, 6.9, 18.3, 25.3_

  - [x] 1.3 Implement money, countdown, and time zone utilities
    - Exact decimal money math and rounding to 2 decimals
    - `formatCountdown` and `parseCountdown` (minutes:seconds and d/h/m/s)
    - Jurisdiction-local to UTC to viewer-zone conversion with zone name or offset display
    - _Requirements: 5.5, 7.1, 7.10_

  - [ ]* 1.4 Write property test for countdown format round trip
    - **Property 17: Countdown format round trip**
    - **Validates: Requirements 5.5, 7.1**

  - [ ]* 1.5 Write property test for time zone round trip
    - **Property 19: Time zone round trip**
    - **Validates: Requirements 7.10**

  - [x] 1.6 Implement the durable job scheduler and retry policy
    - Job queue on PostgreSQL with unique keys `(job_type, entity_id, occurrence)`, resume after restart
    - Retry with exponential backoff, 3 attempts, preserved queue entry, Admin alert after the third failure
    - _Requirements: 7.11, 7.12, 25.5, 25.6_

  - [ ]* 1.7 Write property test for exactly-once scheduled jobs
    - **Property 20: Scheduled jobs run exactly once**
    - **Validates: Requirements 7.11, 25.6**

  - [ ]* 1.8 Write property test for retry with exponential backoff
    - **Property 55: Retry with exponential backoff**
    - **Validates: Requirements 7.12, 25.5**

- [x] 2. Audit service
  - [x] 2.1 Implement the hash-chained audit service
    - `append(tx, event)` inside the caller's transaction (fail closed), `eventHash`, `verifyChain`, `search` (timestamp descending)
    - Revoke UPDATE and DELETE, add trigger that rejects changes and records the rejected attempt through a privileged path
    - Retention of at least 7 years in storage policy
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9_

  - [ ]* 2.2 Write property test for audit chain integrity
    - **Property 46: Audit chain integrity**
    - **Validates: Requirements 18.2, 18.3, 18.8**

  - [ ]* 2.3 Write property test for audit search ordering
    - **Property 47: Audit search ordering**
    - **Validates: Requirements 18.5, 18.6**

  - [ ]* 2.4 Write property test for audit failure aborting the operation
    - **Property 48: Audit failure aborts the operation**
    - **Validates: Requirements 18.9**

- [x] 3. Accounts and authentication
  - [x] 3.1 Implement registration, consent, and age validation
    - `validateRegistration` (email up to 254 characters, E.164 phone, password 12 to 128, generic duplicate handling), `ageOn`, minimum age 18
    - Record policy and terms acceptance with version, user, UTC timestamp; reject registration without acceptance
    - Email verification message within 60 seconds
    - _Requirements: 1.1, 1.2, 13.4, 13.5, 23.3, 23.4_

  - [x] 3.2 Implement sign-in, lockout, MFA, and password reset
    - Argon2id hashing, generic credential errors, unverified-email handling, `nextLockState` (5 failures in 15 minutes, 15-minute lock, lock email)
    - MFA with 6-digit code (SMS or TOTP, 5 attempts), mandatory for Owners and Admins, single-use reset links expiring in 60 minutes
    - httpOnly, secure, SameSite session cookies
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12_

  - [ ]* 3.3 Write property test for registration validation
    - **Property 1: Registration validation**
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 3.4 Write property test for lockout after repeated failures
    - **Property 2: Lockout after repeated failures**
    - **Validates: Requirements 1.6**

  - [ ]* 3.5 Write property test for password hashing round trip
    - **Property 3: Password hashing round trip**
    - **Validates: Requirements 1.12**

  - [ ]* 3.6 Write property test for age verification
    - **Property 34: Age verification**
    - **Validates: Requirements 13.4, 13.5**

- [x] 4. Raffle service
  - [x] 4.1 Implement raffle validation and draft persistence
    - `validateRaffle`, `validateEdit` (locked fields after first sold ticket), `validateDrawTime`
    - Bounds: title, description, images, prize value, tickets 10 to 100,000, currency per country, deadline plus 24 hours, threshold, per-player limit
    - Bilingual title and description fields; `saveDraft` with audit events
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 9.2, 9.3, 20.9_

  - [ ]* 4.2 Write property test for raffle input validation
    - **Property 4: Raffle input validation**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 9.2, 9.3**

  - [ ]* 4.3 Write property test for locked fields after first sale
    - **Property 5: Locked fields after first sale**
    - **Validates: Requirements 2.10, 2.11**

  - [x] 4.4 Implement the raffle state machine, closure decision, and cancellation
    - `transition`, `closureDecision`, publication submission (pending_review then published), cancellation with Admin approval and documented reason
    - Scheduled jobs for deadline closure, threshold evaluation, 24-hour reminder, with retry and owner notification on failure
    - Time zone handling for deadlines
    - _Requirements: 2.12, 2.13, 2.14, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 8.8_

  - [ ]* 4.5 Write property test for legal status transitions
    - **Property 6: Raffle status transitions are legal**
    - **Validates: Requirements 2.12, 2.13, 2.14**

  - [ ]* 4.6 Write property test for the sales closure decision
    - **Property 18: Sales closure decision**
    - **Validates: Requirements 7.2, 7.3, 7.5, 7.6, 7.8, 7.9**

  - [x] 4.7 Implement the External_Lottery catalog and Winning_Rule selection
    - Catalog per country with draw schedule and result format, closed set of Winning_Rules, fallback rule selection
    - Expose rule, fallback and draw time for the Share_Page
    - _Requirements: 9.1, 9.4, 9.5_

- [ ] 5. Inventory service
  - [x] 5.1 Implement reservation, random assignment, release, and counts
    - All-or-nothing SQL reservation with conditional UPDATE, per-player limit check, sales-closed and cancelled rejection, max 100 tickets per checkout
    - `pickRandomAvailable`, `releaseExpired`, `counts`, ticket cancellation on raffle cancellation
    - _Requirements: 4.1, 4.2, 4.4, 5.1, 5.2, 5.3, 5.4, 5.6, 7.3, 8.6, 25.3, 25.7_

  - [ ]* 5.2 Write property test for inventory conservation
    - **Property 8: Inventory conservation**
    - **Validates: Requirements 4.1, 4.2, 8.6**

  - [ ]* 5.3 Write property test for concurrent reservation
    - **Property 9: Concurrent reservation has exactly one winner**
    - **Validates: Requirements 4.4, 25.3, 25.7**

  - [ ]* 5.4 Write property test for all-or-nothing reservation
    - **Property 10: Reservation is all-or-nothing**
    - **Validates: Requirements 5.1, 5.3, 5.4**

  - [ ]* 5.5 Write property test for random assignment validity
    - **Property 11: Random assignment validity**
    - **Validates: Requirements 5.2**

  - [ ] 5.6 Implement idempotent payment confirmation and reservation expiry
    - `applyConfirmation` (sold, refund, noop) with `SELECT ... FOR UPDATE`, `reservationExpiry` capped at 72 hours
    - Expiry job releasing reservations within 10 seconds, deadline-time release with in-progress payment exception (up to 15 minutes)
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 6.8, 6.10, 7.4_

  - [ ]* 5.7 Write property test for idempotent confirmation
    - **Property 12: Payment confirmation is idempotent**
    - **Validates: Requirements 5.9**

  - [ ]* 5.8 Write property test for expiry and late-payment policy
    - **Property 13: Expiry and late-payment policy**
    - **Validates: Requirements 5.6, 5.7, 5.8, 6.10, 6.11**

  - [ ]* 5.9 Write property test for the asynchronous reservation cap
    - **Property 16: Asynchronous reservation expiry cap**
    - **Validates: Requirements 6.8**

  - [x] 5.10 Implement realtime counts, ticket list, and CSV export
    - Redis pub/sub to server-sent events for counts, ticket list with buyer and purchase time, CSV export with 30-second limit and failure handling
    - CSV serializer and parser handling commas, quotes and newlines
    - _Requirements: 4.3, 4.5, 4.6, 4.7, 4.8_

  - [ ]* 5.11 Write property test for CSV export round trip
    - **Property 45: Export round trip**
    - **Validates: Requirements 4.5, 4.6, 17.7**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Payment service
  - [x] 7.1 Implement provider adapter interfaces and core payment functions
    - `PaymentProviderAdapter` interface (hosted fields or redirects only), `methodsFor(country)`, `orderTotal`, idempotency store with 24-hour window and required key
    - Payment record with amount, currency, provider, reference, status; Colombia and US method lists; no-provider handling
    - _Requirements: 3.2, 3.4, 6.1, 6.2, 6.3, 6.4, 6.7, 6.9_

  - [ ]* 7.2 Write property test for charged amount equals displayed total
    - **Property 14: Charged amount equals displayed total**
    - **Validates: Requirements 6.4**

  - [ ]* 7.3 Write property test for payment idempotency keys
    - **Property 15: Payment idempotency keys**
    - **Validates: Requirements 6.7**

  - [ ] 7.4 Implement Creation_Fee and Customization_Fee payments
    - Fee configuration with change isolation, payment confirmation view totals, 30-second result, failure handling that keeps the raffle in draft
    - Per-option customization charges enabled only after success, receipts within 1 minute, full refund of Creation_Fee on pre-publication cancellation
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [ ]* 7.5 Write property test for fee totals and fee-change isolation
    - **Property 7: Fee totals and fee-change isolation**
    - **Validates: Requirements 3.1, 3.8**

  - [ ] 7.6 Implement refund planning, cap, and retry state machine
    - `planRefunds` (full amounts including fees, initiated within 24 hours), `canRefund` cumulative cap, `refundRetry` (3 retries at 24-hour intervals, failed state with owed amount), Back_Office flagging
    - Refund notifications within 5 minutes; no player fee for owner or threshold cancellations
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.9_

  - [ ]* 7.7 Write property test for refund plan and refund cap
    - **Property 21: Refund plan and refund cap**
    - **Validates: Requirements 8.1, 8.7, 8.9**

  - [ ]* 7.8 Write property test for the refund retry state machine
    - **Property 22: Refund retry state machine**
    - **Validates: Requirements 8.4, 8.5**

  - [ ] 7.9 Implement purchase flow, webhooks, and late-payment refunds
    - `pay` with idempotency key, release of reservation on failure within 10 seconds, deduplicated webhook handling (duplicate, late, out of order), receipt within 60 seconds
    - Automatic full refund and notification on late payment with unavailable tickets
    - Chargeback linking and Finance notification within 60 seconds
    - _Requirements: 5.8, 5.9, 6.5, 6.6, 6.10, 6.11, 24.6_

  - [ ] 7.10 Implement the payout ledger and release
    - `ledger` (net proceeds, commission, provider fees, taxes, refunds, disputed hold), tax withholding from rule set, payout account validation by country, `holdReleaseDate` in business days
    - Payout release job, dispute hold, statement within 5 minutes, failed-transfer flagging and owner notification within 1 hour
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9_

  - [ ]* 7.11 Write property test for payout ledger conservation
    - **Property 36: Payout ledger conservation**
    - **Validates: Requirements 14.1, 14.5, 14.8, 14.9**

  - [ ]* 7.12 Write property test for payout account and holding period
    - **Property 37: Payout account and holding period**
    - **Validates: Requirements 14.2, 14.3, 14.4**

- [ ] 8. Draw service
  - [x] 8.1 Implement winning number derivation and winner resolution
    - `deriveWinningNumber` per Winning_Rule, `resolveWinner` with lower, higher and redraw fallbacks, none outcome
    - _Requirements: 9.7, 9.8, 9.9, 9.10_

  - [ ]* 8.2 Write property test for winning number derivation
    - **Property 23: Winning number derivation**
    - **Validates: Requirements 9.4, 9.7**

  - [ ]* 8.3 Write property test for winner resolution with fallback
    - **Property 24: Winner resolution with fallback**
    - **Validates: Requirements 9.8, 9.9, 9.10**

  - [ ] 8.4 Implement result retrieval, postponements, and manual results
    - Result source adapters, retrieval job within 15 minutes of draw time, 2-hour fallback with Admin alert, postponement or cancellation notices within 15 minutes
    - Manual result entry with source reference and second-Admin approval; store result, source, retrieval time, rule and derived number in the Audit_Trail
    - _Requirements: 9.6, 9.8, 9.10, 9.11, 9.12, 9.13, 19.11, 19.12_

  - [ ]* 8.5 Write property test for two-person approval of manual draws
    - **Property 50: Two-person approval of manual draws**
    - **Validates: Requirements 19.11, 19.12**

- [ ] 9. Notification service
  - [x] 9.1 Implement notification core functions
    - `resolveLocale`, `channelsFor` (mandatory versus optional), `parseTemplate` and `renderTemplate` with the five allowed placeholders, `smsSegments` (GSM-7 and UCS-2), `isStopKeyword`, `deliveryPlan`, `winnerMessage` per role
    - _Requirements: 10.2, 10.3, 10.4, 10.6, 10.7, 10.8, 10.9, 11.3, 11.5, 11.6, 11.8, 11.10_

  - [ ]* 9.2 Write property test for winner notification content and privacy
    - **Property 25: Winner notification content and privacy**
    - **Validates: Requirements 10.2, 10.3, 10.4**

  - [ ]* 9.3 Write property test for delivery retry and fallback
    - **Property 26: Delivery retry and fallback**
    - **Validates: Requirements 10.6, 10.7**

  - [ ]* 9.4 Write property test for locale resolution
    - **Property 27: Locale resolution**
    - **Validates: Requirements 10.8, 10.9, 20.2, 20.6**

  - [ ]* 9.5 Write property test for mandatory notification channels
    - **Property 28: Mandatory notification channels**
    - **Validates: Requirements 11.2, 11.3**

  - [ ]* 9.6 Write property test for template placeholders round trip and validation
    - **Property 29: Template placeholders round trip and validation**
    - **Validates: Requirements 11.5, 11.6, 11.13**

  - [ ]* 9.7 Write property test for SMS segment limit and opt-out parsing
    - **Property 30: SMS segment limit and opt-out parsing**
    - **Validates: Requirements 11.8, 11.10**

  - [ ] 9.8 Implement notification workers, adapters, and winner notification flow
    - Email and SMS provider adapters, queue worker with 3 retries at 60 seconds and one alternate channel, notification records with status
    - Preference API (persist within 2 seconds), unsubscribe link in optional emails, inbound STOP and PARAR handling within 1 minute, template editor API with preview, segment count and test send, web push for optional types
    - Trigger winner notifications within 5 minutes of a recorded winner; all notification types in Requirement 11.1
    - _Requirements: 10.1, 10.5, 10.6, 10.7, 11.1, 11.2, 11.4, 11.7, 11.9, 11.10, 11.11, 11.12, 21.6, 21.7_

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Compliance, KYC, fraud, and security
  - [x] 11.1 Implement the compliance rule engine
    - Versioned rule sets with snapshot reference per raffle, `evaluateRules` naming each violated rule and configured value, `validateEvidenceFile` (10 MB, PDF, JPG, PNG)
    - Colombia and US-state evidence requirements, purchase location gating, pending_review queueing within 5 seconds, jurisdiction enablement for new raffles only, required Share_Page disclosures
    - Tax and reporting document generation within 60 seconds with 3 retries at 5-minute intervals
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10_

  - [ ]* 11.2 Write property test for compliance rule evaluation
    - **Property 31: Compliance rule evaluation**
    - **Validates: Requirements 12.1, 12.4, 12.8**

  - [ ]* 11.3 Write property test for evidence file validation
    - **Property 32: Evidence file validation**
    - **Validates: Requirements 12.2, 12.3**

  - [ ]* 11.4 Write property test for purchase location gating
    - **Property 33: Purchase location gating**
    - **Validates: Requirements 12.7**

  - [x] 11.5 Implement KYC integration
    - KYC provider adapter with 30-second timeout, owner KYC before publication, `kycAttemptAllowed` (3 per 24 hours), winner verification above a configurable prize threshold with 30-day withholding, document-based age verification where required
    - Encrypted KYC document storage with restricted access
    - _Requirements: 13.1, 13.2, 13.3, 13.6, 13.7, 13.8, 13.9_

  - [ ]* 11.6 Write property test for the KYC retry limit
    - **Property 35: KYC retry limit**
    - **Validates: Requirements 13.2**

  - [x] 11.7 Implement the fraud service
    - `decide` with block and review thresholds and error handling, `rateLimit` (10 per 60 seconds with retry-after), risk score within 2 seconds, order review queue, raffle fraud suspension within 60 seconds, high-risk owner approval
    - Integrate with the payment flow
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.9_

  - [ ]* 11.8 Write property test for fraud decision thresholds
    - **Property 38: Fraud decision thresholds**
    - **Validates: Requirements 15.2, 15.3, 15.4**

  - [ ]* 11.9 Write property test for rate limiting
    - **Property 39: Rate limiting**
    - **Validates: Requirements 15.5**

  - [ ] 11.10 Implement security middleware
    - TLS 1.2 or later enforcement, CSRF tokens on state-changing requests, input sanitization against script content, parameterized queries only, CSP and output encoding
    - _Requirements: 15.7, 15.8_

- [ ] 12. Back office, support, analytics, share page, privacy
  - [x] 12.1 Implement Back_Office roles, approvals, and configuration
    - Admin MFA gate, `can(roles, action)` for Support, Compliance, Finance and Super Admin, reason validation, raffle approve and reject, suspend and reinstate, Finance retries, Super Admin configuration with change records
    - Review and report queues, raffle report submission within 5 seconds
    - _Requirements: 15.10, 15.11, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10_

  - [ ]* 12.2 Write property test for role-based permissions
    - **Property 49: Role-based permissions**
    - **Validates: Requirements 19.1, 19.2, 19.3**

  - [ ]* 12.3 Write property test for bounded text inputs
    - **Property 40: Bounded text inputs**
    - **Validates: Requirements 8.8, 15.10, 15.11, 19.4, 19.5, 19.8, 24.3**

  - [ ] 12.4 Implement support cases, disputes, and delivery tracking
    - Case creation with validation and linkage, case number confirmation within 60 seconds, dispute view with lottery result, rule and derived number from the Audit_Trail, missing-item flagging
    - Prize delivery confirmation and 30-day reminder and Admin alert
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.7, 24.8_

  - [ ] 12.5 Implement the Analytics_Dashboard backend
    - Sales, inventory and refund metrics, conversion rates, zero-filled daily series, traffic sources (direct, QR, referral), 60-second freshness, CSV export within 10 seconds with no partial file on failure, owner-only access
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_

  - [ ]* 12.6 Write property test for analytics aggregates
    - **Property 43: Analytics aggregates**
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5**

  - [ ]* 12.7 Write property test for analytics access control
    - **Property 44: Analytics access control**
    - **Validates: Requirements 17.9, 17.10**

  - [ ] 12.8 Implement the Share_Page backend, token, QR, and metadata
    - 128-bit random share token, QR generation in PNG (at least 1024 by 1024) and SVG, Open Graph metadata with length limits and image of at least 1200 by 630, identical not-found response for missing and unpublished raffles
    - Share_Page data with disclosures, countdown, availability, winner result display within 5 seconds, custom branding, and checkout redirect back with preserved selections
    - _Requirements: 10.5, 12.6, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10_

  - [ ]* 12.9 Write property test for share token and QR round trip
    - **Property 41: Share token and QR round trip**
    - **Validates: Requirements 16.1, 16.2, 16.3**

  - [ ]* 12.10 Write property test for share page availability and metadata
    - **Property 42: Share page availability and metadata**
    - **Validates: Requirements 16.6, 16.9**

  - [ ] 12.11 Implement privacy and data protection features
    - Data export (receipt within 24 hours, delivery within 30 days) and deletion or anonymization with retained-category report, failure notices before day 30
    - Consent management for marketing and analytics cookies (withdrawal within 24 hours), `displayName` ("First L." only with consent, otherwise anonymous, withdrawal within 24 hours), breach notification to the Admin security contact within 1 hour, encryption of personal data at rest
    - _Requirements: 23.1, 23.2, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14_

  - [ ]* 12.12 Write property test for consent gating and name display
    - **Property 54: Consent gating and name display**
    - **Validates: Requirements 23.3, 23.4, 23.13, 23.14**

- [ ] 13. PWA client
  - [x] 13.1 Implement the Next.js app shell, localization, and formatting
    - English and Spanish JSON resource files, key parity CI check, `detectLocale`, locale switch within 1 second preserving form input, profile persistence with retry on failure, English fallback with once-per-key logging
    - `formatMoney` using the raffle currency, bilingual raffle content selection with fallback
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.7, 20.8, 20.9, 20.10_

  - [ ]* 13.2 Write property test for localized content fallback
    - **Property 51: Localized content fallback**
    - **Validates: Requirements 20.1, 20.7, 20.9, 20.10**

  - [ ]* 13.3 Write property test for currency formatting
    - **Property 52: Currency formatting**
    - **Validates: Requirements 20.5**

  - [x] 13.4 Implement PWA capabilities
    - Web app manifest, Workbox service worker with 7-day Raffle page cache, offline notices and fallback page, purchase blocking offline with selections preserved, stale-counts indicator within 10 seconds, update prompt and refresh, web push permission handling
    - Responsive layouts from 320 px to 1920 px
    - _Requirements: 4.8, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.9, 21.10_

  - [ ] 13.5 Implement owner and player flows with accessible ticket selection
    - Registration and sign-in screens, raffle creation form with fee confirmation, owner dashboard with countdown and ticket list
    - Ticket selection with grid, list and number-input views sharing one selection state, reservation countdown, single ARIA live region (status changes, form errors, 5 minute, 1 minute and 10 second marks), keyboard operation, visible focus indicators, alt text of at most 150 characters
    - _Requirements: 2.1, 3.1, 5.1, 5.5, 7.1, 22.2, 22.3, 22.4, 22.6, 22.7_

  - [ ] 13.6 Implement theme contrast validation and custom theme support
    - `contrastRatio` per WCAG, theme rejection with failing pair and measured ratio, previous theme retained
    - _Requirements: 22.5, 22.8_

  - [ ]* 13.7 Write property test for theme contrast validation
    - **Property 53: Theme contrast validation**
    - **Validates: Requirements 22.5, 22.8**

  - [ ] 13.8 Implement Share_Page, analytics, notification editor, and back office screens
    - Server-rendered Share_Page with Open Graph tags, Analytics_Dashboard views and export, notification preferences and template editor with preview, Back_Office review queue, audit search, refund and payout views, support and dispute screens
    - _Requirements: 4.3, 11.2, 11.4, 11.7, 11.9, 16.4, 16.5, 16.7, 17.1, 18.5, 19.6, 19.10, 24.1_

  - [ ]* 13.9 Write accessibility and PWA checks
    - axe-core scan in both locales (zero violations), keyboard-only flow tests, Lighthouse mobile preset median of 5 runs at 80 or above on the Share_Page, installability and update prompt tests
    - _Requirements: 21.8, 22.1, 22.2_

- [ ] 14. Integration and wiring
  - [ ] 14.1 Wire modules end to end
    - Publication flow: submit raffle, fee payment, compliance and KYC checks, pending_review or published, share token and QR generation
    - Checkout flow: compliance location and age check, fraud scoring, reservation, payment, webhook confirmation, receipt
    - Closure, cancellation and refund flow, draw and winner notification flow, payout flow; audit events on all audited operations
    - _Requirements: 2.12, 2.13, 5.3, 6.4, 7.7, 8.1, 9.8, 10.1, 12.4, 13.1, 14.4, 15.1, 18.1_

  - [ ]* 14.2 Write integration tests for key flows
    - Provider sandbox and contract fixtures for payment, KYC, SMS, email and lottery adapters (duplicate, late, out-of-order webhooks)
    - PostgreSQL tests for audit immutability, reservation locking with parallel connections, realtime count latency, share page load target
    - _Requirements: 4.4, 5.9, 6.7, 18.4, 25.2, 25.3, 25.5_

- [ ] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design (Properties 1 to 55)
- Unit tests validate specific examples and edge cases
- Compliance rule sets must be reviewed by qualified legal counsel before launch

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "1.5", "1.6", "2.1", "3.1", "4.1", "8.1", "9.1", "11.1", "13.1"] },
    { "id": 3, "tasks": ["1.7", "1.8", "2.2", "2.3", "2.4", "3.2", "3.3", "3.6", "4.2", "4.3", "4.4", "4.7", "5.1", "7.1", "8.2", "8.3", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7", "11.2", "11.3", "11.4", "11.5", "11.7", "12.1", "13.2", "13.3", "13.4"] },
    { "id": 4, "tasks": ["3.4", "3.5", "4.5", "4.6", "5.2", "5.3", "5.4", "5.5", "5.6", "7.2", "7.3", "7.4", "7.6", "8.4", "9.8", "11.6", "11.8", "11.9", "11.10", "12.2", "12.3", "12.4", "12.5", "12.8"] },
    { "id": 5, "tasks": ["5.7", "5.8", "5.9", "5.10", "7.5", "7.7", "7.8", "7.9", "7.10", "8.5", "12.6", "12.7", "12.9", "12.10", "12.11", "13.5", "13.6"] },
    { "id": 6, "tasks": ["5.11", "7.11", "7.12", "12.12", "13.7", "13.8"] },
    { "id": 7, "tasks": ["13.9", "14.1"] },
    { "id": 8, "tasks": ["14.2"] }
  ]
}
```

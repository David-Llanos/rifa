# Requirements Document

## Introduction

The Raffle Platform is a bilingual (English and Spanish) Progressive Web App that lets Owners create, customize, publish, and run raffles, and lets Players buy tickets using local payment methods. Each Raffle is tied to an External Lottery draw. The platform tracks ticket inventory and the Raffle deadline, derives the winning ticket number from the official lottery result, and notifies the Owner and Players automatically by email and SMS. The platform launches in Colombia and the United States, and supports payment methods, currencies, and legal compliance rules for each jurisdiction. Owners pay a fee to create and customize a Raffle. The platform also covers refunds, reservation timeouts, owner payouts, identity and age verification, fraud prevention, shareable pages, analytics, audit trail, an admin back office, accessibility, and privacy.

Legal note: Colombian raffles (rifas) are regulated by Coljuegos and territorial authorities, and US raffles are regulated state by state. The compliance rules in this document must be validated by qualified legal counsel before launch.

## Glossary

- **Platform**: The Raffle Platform system as a whole, including the web app, backend services, and integrations.
- **PWA_Client**: The installable Progressive Web App front end used by Owners, Players, and Admins.
- **Owner**: A registered user who creates and manages a Raffle.
- **Player**: A user who buys one or more Tickets in a Raffle.
- **Admin**: A Platform staff user with access to the Back_Office.
- **Raffle**: A draw created by an Owner, with a prize, a Ticket inventory, a Ticket price, a deadline, and an associated External_Lottery.
- **Ticket**: A numbered entry in a Raffle that a Player can buy.
- **Ticket_Inventory**: The set of Tickets of a Raffle with their statuses: Available, Reserved, or Sold.
- **Reservation**: A temporary hold on selected Tickets for a Player while payment is pending.
- **Reservation_Timeout**: The maximum duration of a Reservation, set to 10 minutes.
- **Raffle_Service**: The Platform component that manages Raffle creation, configuration, and lifecycle.
- **Inventory_Service**: The Platform component that manages Ticket_Inventory and Reservations.
- **Payment_Service**: The Platform component that processes payments, refunds, and payouts through Payment_Providers.
- **Payment_Provider**: An external payment processor or method available in a given country.
- **Draw_Service**: The Platform component that retrieves External_Lottery results and determines the winner.
- **Notification_Service**: The Platform component that sends email and SMS messages.
- **Compliance_Service**: The Platform component that enforces jurisdiction rules, KYC, and age checks.
- **Fraud_Service**: The Platform component that scores and blocks suspicious activity.
- **Audit_Service**: The Platform component that records the Audit_Trail.
- **Audit_Trail**: An append-only log of security- and money-relevant events.
- **Back_Office**: The Admin-only web interface for operating the Platform.
- **Analytics_Dashboard**: The Owner-facing view of Raffle sales and engagement metrics.
- **External_Lottery**: An official third-party lottery chosen by the Owner whose published result determines the winning number (for example, a Colombian departmental lottery or a US state lottery draw).
- **Winning_Rule**: The configured rule that derives a winning Ticket number from the External_Lottery result.
- **Minimum_Ticket_Threshold**: The minimum number of Tickets that must be sold for a Raffle to proceed to its draw.
- **Creation_Fee**: The amount an Owner pays to create a Raffle.
- **Customization_Fee**: The amount an Owner pays for optional Raffle customization features.
- **Platform_Commission**: The percentage of Ticket sales retained by the Platform.
- **Payout**: A transfer of net Raffle proceeds to the Owner.
- **KYC**: Know Your Customer identity verification.
- **Jurisdiction**: Colombia or a United States state, determined by the Owner's and Raffle's declared location.
- **Locale**: A language selection of English (en) or Spanish (es).
- **Notification_Template**: A configurable message body and subject for a notification type and channel.
- **Share_Page**: The public web page for a Raffle, reachable by URL and QR code.


## Requirements

### Requirement 1: Account Registration and Authentication

**User Story:** As an Owner or Player, I want to create an account and sign in securely, so that I can manage my raffles and purchases.

#### Acceptance Criteria

1. WHEN a visitor submits an email address in valid format (maximum 254 characters) that is not registered, a phone number in valid E.164 format, and a password of 12 to 128 characters, THE Platform SHALL create an account in unverified status and send an email verification message within 60 seconds.
2. IF a visitor submits an email address or phone number that is already registered, an invalid email or phone format, or a password outside 12 to 128 characters, THEN THE Platform SHALL reject the registration, create no account, retain the other entered field values, and display an error indicating which field is invalid, without confirming whether the email address or phone number is already registered.
3. WHEN a user submits valid credentials for a verified account, THE Platform SHALL start an authenticated session within 3 seconds.
4. IF a user submits valid credentials for an account that is not email-verified, THEN THE Platform SHALL reject the sign-in, start no session, and display a message indicating that email verification is required with an option to resend the verification message.
5. IF a user submits invalid credentials, THEN THE Platform SHALL reject the sign-in, start no session, and display the same generic error message regardless of whether the email or the password was incorrect.
6. IF a user submits 5 consecutive failed sign-in attempts within 15 minutes, THEN THE Platform SHALL lock the account for 15 minutes, reject all sign-in attempts during the lock including those with valid credentials, and notify the account holder by email within 60 seconds.
7. WHERE multi-factor authentication is enabled by a user, THE Platform SHALL require a 6-digit one-time code, delivered by SMS or generated by an authenticator app, after valid credentials are submitted and before starting the session.
8. IF a user submits an incorrect or expired one-time code, THEN THE Platform SHALL reject the sign-in, start no session, and allow a maximum of 5 code attempts before requiring credentials to be entered again.
9. THE Platform SHALL require Owners and Admins to complete multi-factor authentication at every sign-in.
10. WHEN a user requests a password reset, THE Platform SHALL send a single-use reset link to the registered email address within 60 seconds, and the link SHALL expire 60 minutes after it is sent.
11. IF a user opens a password reset link that has expired or has already been used, THEN THE Platform SHALL reject the reset, leave the existing password unchanged, and display an error indicating that the link is no longer valid.
12. THE Platform SHALL store passwords only as salted hashes produced by an adaptive hashing algorithm, and SHALL NOT store or log passwords in plain text.

### Requirement 2: Raffle Creation and Configuration

**User Story:** As an Owner, I want to create a raffle with its prize, tickets, price, and deadline, so that I can sell tickets to Players.

#### Acceptance Criteria

1. WHEN an Owner submits a Raffle with a title of 1 to 100 characters, a description of 1 to 5,000 characters, 1 to 10 prize images, a prize value greater than 0, a total Ticket count, a Ticket price, a currency, a deadline, and an External_Lottery, THE Raffle_Service SHALL save the Raffle in draft status and return a confirmation to the Owner.
2. IF an Owner submits a Raffle with a missing required field or a field value outside its allowed bounds, THEN THE Raffle_Service SHALL reject the submission, return an error message that identifies each invalid field and the violated constraint, and not save the Raffle.
3. THE Raffle_Service SHALL accept a total Ticket count that is an integer from 10 to 100,000 inclusive.
4. IF the submitted total Ticket count is outside the range of 10 to 100,000 or is not an integer, THEN THE Raffle_Service SHALL reject the Raffle and return an error message that states the allowed range.
5. THE Raffle_Service SHALL accept a Ticket price greater than 0 in the currency of the Raffle, with COP for Colombian Raffles and USD for US Raffles.
6. IF the submitted currency does not match the currency required for the Raffle's country, or the Ticket price is 0 or negative, THEN THE Raffle_Service SHALL reject the Raffle and return an error message that states the required currency and a Ticket price greater than 0.
7. IF the submitted deadline is earlier than 24 hours after the time of submission, THEN THE Raffle_Service SHALL reject the Raffle and return an error message that states the minimum deadline as the submission time plus 24 hours.
8. WHEN an Owner sets a Minimum_Ticket_Threshold, THE Raffle_Service SHALL accept the threshold only if it is an integer from 1 to the total Ticket count inclusive, and SHALL otherwise reject the Raffle and return an error message that states the allowed range.
9. WHEN an Owner sets a maximum number of Tickets per Player, THE Raffle_Service SHALL accept only an integer from 1 to the total Ticket count inclusive, and SHALL reject any purchase that would bring a Player's total Tickets in that Raffle above that limit, leaving the Player's existing Tickets unchanged.
10. WHILE a Raffle is in draft status, THE Raffle_Service SHALL allow the Owner to edit all Raffle fields, subject to the same validation as in criteria 1 to 9.
11. WHILE a Raffle has at least one Sold Ticket, THE Raffle_Service SHALL prevent changes to Ticket price, total Ticket count, deadline, External_Lottery, and Winning_Rule, and SHALL return an error message stating that the field cannot be changed after a Ticket has been sold.
12. WHEN an Owner submits a Raffle for publication, THE Raffle_Service SHALL set the Raffle status to pending_review until the Creation_Fee payment and the compliance checks in Requirement 12 succeed or Admin approval is granted, and SHALL then set the status to published.
13. IF the Creation_Fee payment or any compliance check in Requirement 12 fails, THEN THE Raffle_Service SHALL keep the Raffle unpublished, notify the Owner of the failure reason, and retain all Raffle data.
14. THE Raffle_Service SHALL support the Raffle statuses draft, pending_review, published, sales_closed, awaiting_draw, completed, and cancelled.

### Requirement 3: Creation Fee and Customization Payments

**User Story:** As the Platform operator, I want Owners to pay to create and customize a raffle, so that the Platform generates revenue.

#### Acceptance Criteria

1. WHEN an Owner opens the payment confirmation view for a Raffle, THE Platform SHALL display the Creation_Fee and each selected Customization_Fee, each as an amount in the currency of the Raffle, together with the total amount to be charged, before the Owner can confirm payment.
2. WHEN an Owner confirms payment of the Creation_Fee, THE Payment_Service SHALL charge the Owner the displayed amount through a Payment_Provider available in the Raffle country and SHALL return a success or failure result to the Owner within 30 seconds.
3. IF the Creation_Fee payment fails or does not complete within 30 seconds, THEN THE Raffle_Service SHALL keep the Raffle in draft status, SHALL NOT record the Creation_Fee as paid, SHALL retain all data entered by the Owner, and SHALL display to the Owner a message indicating the failure reason and an option to retry the payment.
4. IF no Payment_Provider is available in the Raffle country, THEN THE Payment_Service SHALL NOT charge the Owner, SHALL keep the Raffle in draft status, and SHALL display a message to the Owner indicating that no payment method is available for the Raffle country.
5. WHERE an Owner selects a customization option (custom branding, custom Share_Page theme, extra prize images, or custom Notification_Templates), THE Payment_Service SHALL charge the Customization_Fee corresponding to that option, once per selected option, and SHALL enable the option only after its payment succeeds.
6. IF a Customization_Fee payment fails, THEN THE Platform SHALL leave the customization option disabled for the Raffle, SHALL keep the Owner's selection, and SHALL display to the Owner a message indicating the failure reason.
7. WHEN a Creation_Fee or Customization_Fee payment succeeds, THE Platform SHALL send a receipt by email to the Owner within 1 minute, stating the item paid, the amount, the currency, and the payment date and time.
8. WHEN an Admin changes a fee in the Back_Office, THE Platform SHALL apply the new fee only to payments initiated after the change is saved, and SHALL NOT alter the amount of any payment already initiated or completed.
9. WHEN an Owner cancels a Raffle that has no Sold Tickets before publication, THE Payment_Service SHALL refund the Creation_Fee in full, in the original currency, to the original payment method, and SHALL notify the Owner that the refund was issued.

### Requirement 4: Ticket Inventory Tracking

**User Story:** As an Owner, I want to see tickets sold and available in real time, so that I can track the progress of my raffle.

#### Acceptance Criteria

1. THE Inventory_Service SHALL maintain, for each Ticket, exactly one status of Available, Reserved, Sold, or Cancelled, where Cancelled is set only on Raffle cancellation as defined in Requirement 8.
2. THE Inventory_Service SHALL maintain the invariant that the count of Available Tickets plus the count of Reserved Tickets plus the count of Sold Tickets plus the count of Cancelled Tickets equals the total Ticket count of the Raffle at all times.
3. WHEN a Ticket status changes, THE PWA_Client SHALL show the updated Available, Reserved, and Sold counts to Owners and Players viewing the Raffle within 5 seconds of the change.
4. IF two Players attempt to reserve the same Available Ticket concurrently, THEN THE Inventory_Service SHALL grant the Reservation to exactly one Player, leave the Ticket status as Reserved for the winning Player, and reject the other request with an error message indicating the Ticket is unavailable.
5. WHEN an Owner opens the Ticket list for a Raffle, THE PWA_Client SHALL display each Ticket with its number and status and, for each Sold Ticket, the buyer name and purchase date and time.
6. WHEN an Owner requests an export, THE Platform SHALL generate a CSV file containing the same fields as the Ticket list for every Ticket of the Raffle within 30 seconds for Raffles of up to 100,000 Tickets.
7. IF the CSV export is not completed within 30 seconds or fails, THEN THE Platform SHALL display an error message to the Owner indicating the export failed and SHALL leave all Ticket data unchanged.
8. IF the PWA_Client cannot receive updated counts because the connection is lost, THEN THE PWA_Client SHALL display an indication to the user that the counts may be outdated within 10 seconds of the connection loss.

### Requirement 5: Ticket Selection, Reservation, and Timeout

**User Story:** As a Player, I want to choose my ticket numbers and hold them while I pay, so that nobody else takes them.

#### Acceptance Criteria

1. WHERE the Owner has enabled number selection, THE PWA_Client SHALL let a Player choose specific Ticket numbers, limited to Tickets in Available status, up to a maximum of 100 Tickets per checkout.
2. WHERE the Owner has not enabled number selection, THE Inventory_Service SHALL assign random Available Ticket numbers to the Player after payment confirmation, equal in count to the quantity the Player purchased.
3. WHEN a Player starts checkout with selected Tickets that are all Available, THE Inventory_Service SHALL create a Reservation lasting the Reservation_Timeout and set those Tickets to Reserved status within 2 seconds.
4. IF a Player starts checkout and any selected Ticket is not Available, THEN THE Inventory_Service SHALL reject the checkout without creating a Reservation, leave all selected Tickets' statuses unchanged, and THE PWA_Client SHALL show an error indicating which Tickets are unavailable.
5. WHILE a Reservation is active, THE PWA_Client SHALL show the remaining time to the Player as minutes and seconds, updated every 1 second.
6. WHEN a Reservation reaches the Reservation_Timeout without a confirmed payment, THE Inventory_Service SHALL release the reserved Tickets to Available status within 10 seconds.
7. WHEN a payment confirmation is received for an expired Reservation and the Tickets are still Available, THE Inventory_Service SHALL convert the Tickets to Sold.
8. IF a payment confirmation is received for an expired Reservation and any Ticket is no longer Available, THEN THE Payment_Service SHALL refund the payment in full automatically, THE Inventory_Service SHALL leave the Tickets' statuses unchanged, and THE Notification_Service SHALL notify the Player of the refund within 60 seconds.
9. WHEN a payment is confirmed, THE Inventory_Service SHALL convert the reserved Tickets to Sold exactly once, regardless of repeated payment confirmation messages (idempotence).

### Requirement 6: Ticket Purchase and Payment Methods

**User Story:** As a Player, I want to pay with a method I use in my country, so that I can buy tickets easily.

#### Acceptance Criteria

1. WHERE the Raffle country is Colombia, THE Payment_Service SHALL offer PSE, Nequi, credit and debit cards, and cash-payment networks (such as Efecty) through supported Payment_Providers.
2. WHERE the Raffle country is the United States, THE Payment_Service SHALL offer credit and debit cards, Apple Pay, Google Pay, and ACH bank transfer through supported Payment_Providers.
3. THE Payment_Service SHALL process card data only through Payment_Provider hosted fields or redirects so that the Platform does not store card numbers or security codes.
4. WHEN a Player confirms a purchase, THE Payment_Service SHALL charge the total of Ticket price multiplied by Ticket count, plus any displayed fees, in the Raffle currency, and the charged amount SHALL equal the total displayed to the Player at confirmation.
5. WHEN a payment succeeds, THE Platform SHALL send a purchase receipt containing the purchased Ticket numbers to the Player's email address within 60 seconds of payment confirmation.
6. IF a payment fails or is declined, THEN THE Platform SHALL release the Reservation within 10 seconds, return the Tickets to Available status, show the Player a failure reason in the selected Locale, and keep the Player's Ticket selection available to retry.
7. WHEN the Payment_Service receives a payment attempt, THE Payment_Service SHALL require a unique idempotency key, and IF a submission repeats an idempotency key already used within the previous 24 hours, THEN THE Payment_Service SHALL return the result of the original attempt without creating an additional charge.
8. WHILE a payment method has asynchronous confirmation (such as cash payment or ACH), THE Inventory_Service SHALL keep the Reservation active until payment confirmation or the method-specific expiry, up to a maximum of 72 hours.
9. THE Payment_Service SHALL record each payment with amount, currency, provider, provider reference, and status, where status is one of pending, succeeded, failed, or expired.
10. IF an asynchronous payment is not confirmed before the Reservation expires, THEN THE Platform SHALL release the Reservation, return the Tickets to Available status, and notify the Player by email within 60 seconds of expiry that the purchase was not completed.
11. IF a payment confirmation arrives after the Reservation has expired and the Tickets are no longer available, THEN THE Payment_Service SHALL refund the full amount charged to the original payment method and notify the Player by email within 60 seconds of detecting the conflict.

### Requirement 7: Deadline Tracking and Sales Closure

**User Story:** As an Owner, I want the platform to track my raffle deadline, so that sales stop on time and the draw proceeds automatically.

#### Acceptance Criteria

1. WHILE a Raffle has status published, THE PWA_Client SHALL display the time remaining until the Raffle deadline on the Raffle page and in the Owner dashboard, in days, hours, minutes and seconds, and refresh the displayed value at least once every 1 second.
2. WHEN the Raffle deadline is reached, THE Raffle_Service SHALL change the Raffle status to sales_closed within 5 seconds of the deadline.
3. WHILE a Raffle has status sales_closed, THE Inventory_Service SHALL reject new Reservations and return an error indicating that sales are closed, leaving existing Reservations and Sold Tickets unchanged.
4. WHEN the Raffle deadline is reached, THE Inventory_Service SHALL release each Reservation still unpaid at that time, unless a payment for that Reservation is already in progress, in which case the Reservation SHALL be kept until the payment is confirmed or fails, for a maximum of 15 minutes.
5. WHERE the Owner has enabled early closure, WHEN all Tickets of a Raffle are Sold before the deadline, THE Raffle_Service SHALL change the Raffle status to sales_closed within 5 seconds of the last Ticket being Sold.
6. IF the Owner has not enabled early closure and all Tickets of a Raffle are Sold before the deadline, THEN THE Raffle_Service SHALL keep the Raffle status unchanged and THE Inventory_Service SHALL reject new Reservations because no Tickets are available, until the deadline is reached.
7. WHEN the Raffle status changes to sales_closed, THE Raffle_Service SHALL evaluate the Minimum_Ticket_Threshold within 1 minute.
8. IF the count of Sold Tickets is at least the Minimum_Ticket_Threshold at closure, THEN THE Raffle_Service SHALL change the Raffle status to awaiting_draw.
9. IF the count of Sold Tickets is lower than the Minimum_Ticket_Threshold at closure, THEN THE Raffle_Service SHALL apply the cancellation and refund process in Requirement 8.
10. THE Platform SHALL calculate deadlines in the Raffle Jurisdiction time zone and display times in the time zone of the viewing user, including the time zone name or UTC offset.
11. WHEN the time remaining until the Raffle deadline first becomes 24 hours or less for a Raffle with status published, THE Notification_Service SHALL send exactly one reminder to the Owner within 5 minutes.
12. IF the Raffle_Service fails to change the Raffle status or evaluate the Minimum_Ticket_Threshold, THEN THE Raffle_Service SHALL retry up to 3 times at 30-second intervals, keep the Raffle in its previous state with all Sold Tickets preserved, and THE Notification_Service SHALL notify the Owner if all retries fail.

### Requirement 8: Cancellation and Refunds

**User Story:** As a Player, I want my money back if the raffle does not take place, so that I am protected.

#### Acceptance Criteria

1. IF a Raffle is cancelled after Tickets are Sold, THEN THE Payment_Service SHALL refund every Sold Ticket payment in full, including any fees charged to the Player, to the original payment method.
2. WHEN a Raffle is cancelled, THE Payment_Service SHALL initiate all refunds within 24 hours of the cancellation timestamp.
3. WHEN a refund is initiated, THE Notification_Service SHALL send the affected Player a notification within 5 minutes containing the refund amount, the currency, and the expected settlement date.
4. IF a refund to the original payment method fails, THEN THE Payment_Service SHALL flag the refund in the Back_Office within 1 minute of the failure, retain the refund as pending, and retry up to 3 times at 24-hour intervals.
5. IF a refund still fails after the third retry, THEN THE Payment_Service SHALL mark the refund as "failed" in the Back_Office, keep the refund amount recorded as owed to the Player, and THE Notification_Service SHALL notify the Player that the refund requires manual resolution.
6. WHEN a Raffle is cancelled, THE Inventory_Service SHALL set all Tickets of that Raffle to a cancelled state and SHALL reject any new Reservation for that Raffle with an error indicating the Raffle is cancelled.
7. WHEN a refund is completed, THE Payment_Service SHALL record the refund so that the cumulative refunded amount for a payment never exceeds the total amount paid for that payment (invariant), and SHALL reject any refund request that would exceed that amount with an error indicating the limit was exceeded.
8. WHERE an Owner requests cancellation of a published Raffle with Sold Tickets, THE Platform SHALL keep the Raffle active until an Admin approves the request and a documented reason of 1 to 500 characters is recorded.
9. THE Platform SHALL charge Players a fee of 0.00 for cancellation caused by the Owner or by the Minimum_Ticket_Threshold not being met.

### Requirement 9: External Lottery Association and Winning Number Derivation

**User Story:** As an Owner, I want to tie my raffle to an official lottery, so that the winner is chosen transparently.

#### Acceptance Criteria

1. THE Raffle_Service SHALL provide a catalog of supported External_Lotteries per country, each with draw schedule and result format.
2. WHEN an Owner selects an External_Lottery, THE Raffle_Service SHALL require a draw date and time that is later than the Raffle deadline.
3. IF the draw date and time entered by the Owner is equal to or earlier than the Raffle deadline, THEN THE Raffle_Service SHALL reject the selection, retain the other entered Raffle data, and display an error indicating that the draw must be later than the deadline.
4. THE Raffle_Service SHALL require the Owner to select exactly one Winning_Rule from a predefined list, such as the last N digits of the first prize number, with N equal to the number of digits of the Ticket numbers.
5. THE Raffle_Service SHALL display the Winning_Rule, the selected fallback rule, and the External_Lottery draw date and time on the Share_Page before any Ticket is sold.
6. WHEN the External_Lottery draw time has passed, THE Draw_Service SHALL retrieve the official result from the configured source within 15 minutes.
7. WHEN the Draw_Service retrieves a result, THE Draw_Service SHALL apply the Winning_Rule to derive the winning Ticket number deterministically, so that the same result and rule always give the same winning number.
8. IF the derived winning number matches a Sold Ticket, THEN THE Draw_Service SHALL record that Ticket and its Player as the winner and set the Raffle status to completed.
9. IF the derived winning number matches an unsold Ticket, THEN THE Draw_Service SHALL apply the fallback rule that the Owner selected at creation (next lower Sold Ticket number, next higher Sold Ticket number, or redraw on the next External_Lottery draw).
10. IF the fallback rule finds no Sold Ticket in the chosen direction, or no Ticket has been sold, THEN THE Draw_Service SHALL keep the Raffle status unchanged, alert Admins and notify the Owner within 15 minutes, and indicate that no winner could be determined.
11. IF the result cannot be retrieved automatically within 2 hours after the draw time, THEN THE Draw_Service SHALL alert Admins and allow an Admin to enter the result manually with a recorded source reference and second-Admin approval.
12. IF the External_Lottery draw is postponed or cancelled, THEN THE Draw_Service SHALL notify the Owner and Players of the new draw date or the cancellation within 15 minutes of detecting the change, and SHALL keep the Raffle status unchanged.
13. THE Draw_Service SHALL store the official result, source reference, retrieval time, Winning_Rule, and derived number in the Audit_Trail.

### Requirement 10: Automated Winner Notification

**User Story:** As an Owner and Player, I want to be told the winner automatically, so that the outcome is clear and prompt.

#### Acceptance Criteria

1. WHEN a winner is recorded, THE Notification_Service SHALL send a winner notification to the Owner, the winning Player, and every other Player of the Raffle within 5 minutes of the winner being recorded.
2. THE Notification_Service SHALL include in the winner notification to the Owner the winning Ticket number, the winning Player's name, and the winning Player's contact data.
3. THE Notification_Service SHALL include in the winner notification to the winning Player the winning Ticket number and a statement that the Player won.
4. THE Notification_Service SHALL include in the notification to each non-winning Player the winning Ticket number and a link to the Share_Page, and SHALL NOT include the winner's name or contact data.
5. WHEN a winner is recorded, THE Share_Page SHALL display the winning Ticket number, the External_Lottery result, and the Winning_Rule within 5 seconds of the winner being recorded.
6. IF delivery of a notification on a channel fails, THEN THE Notification_Service SHALL retry on the same channel up to 3 times, waiting 60 seconds between attempts, and, IF all 3 retries fail and the recipient has consented to an alternate channel, THEN THE Notification_Service SHALL attempt delivery once on that alternate channel.
7. IF delivery fails on all permitted channels and retries, THEN THE Notification_Service SHALL mark the notification as undelivered for that recipient, make the undelivered status visible to the Owner, and continue delivering notifications to the remaining recipients.
8. THE Notification_Service SHALL send each notification in the Locale selected by the recipient.
9. IF the recipient has not selected a Locale, THEN THE Notification_Service SHALL send the notification in the Raffle's default Locale.

### Requirement 11: Customizable Email and SMS Notifications

**User Story:** As an Owner or Player, I want to control which notifications I receive and how they look, so that messages fit my needs.

#### Acceptance Criteria

1. THE Notification_Service SHALL support email and SMS channels for these notification types: account verification, purchase receipt, reservation expiry, payment failure, refund, deadline reminder, sales milestone, winner announcement, Raffle status change, and payout.
2. THE PWA_Client SHALL let each user enable or disable each non-mandatory notification type per channel, and SHALL persist the change within 2 seconds of the user's confirmation.
3. THE Notification_Service SHALL send mandatory notifications (account security, receipts, refunds, and winner announcements) regardless of preference changes, using at least one channel that the recipient has a valid address or number for.
4. WHERE an Owner has purchased the custom Notification_Templates option, THE PWA_Client SHALL let the Owner edit the subject (1 to 150 characters, email only) and body (1 to 5,000 characters for email, 1 to 480 characters for SMS) of Player-facing Notification_Templates for the Raffle, per Locale and channel.
5. THE Notification_Service SHALL support placeholders (player name, Ticket numbers, Raffle title, deadline, and winning number) in Notification_Templates.
6. IF a Notification_Template references an unknown placeholder, THEN THE PWA_Client SHALL reject the save, keep the previously saved template unchanged, and display an error that identifies each unknown placeholder by name.
7. WHEN an Owner edits a Notification_Template, THE PWA_Client SHALL offer a preview, rendered with sample values within 3 seconds, and a test send to the Owner's own verified email address or phone number.
8. IF a rendered SMS message exceeds 3 SMS segments, THEN THE PWA_Client SHALL reject the template, keep the previously saved template unchanged, and display an error indicating the segment limit of 3 was exceeded.
9. THE PWA_Client SHALL display the SMS segment count in the preview of every SMS Notification_Template.
10. WHEN a Player replies STOP or PARAR (case-insensitive, ignoring surrounding whitespace) to an SMS, THE Notification_Service SHALL stop sending non-mandatory SMS messages to that number within 1 minute and SHALL continue sending mandatory SMS messages.
11. THE Notification_Service SHALL include an unsubscribe link in every non-mandatory email.
12. THE Notification_Service SHALL record each notification with type, channel, recipient, status (queued, sent, delivered, or failed), and timestamp.
13. FOR ALL valid Notification_Templates, rendering a template, then parsing its placeholders from the template source, SHALL yield the same set of placeholders that the template contains (placeholder round-trip property).

### Requirement 12: Jurisdiction Compliance (Colombia and United States)

**User Story:** As the Platform operator, I want each raffle to meet local legal rules, so that the Platform and its Owners operate lawfully.

#### Acceptance Criteria

1. THE Compliance_Service SHALL maintain, for each enabled Jurisdiction, a configurable rule set covering permitted Raffle types, maximum prize value (a decimal amount greater than 0 and up to 999,999,999.99 in the Jurisdiction's currency), required licenses or registrations, required disclosures, tax handling, and prohibited Owner types.
2. WHERE the Raffle Jurisdiction is Colombia, THE Compliance_Service SHALL require the Owner to provide, before publication, the authorization or registration evidence required by Coljuegos or the competent territorial authority, as a document file of at most 10 MB in PDF, JPG, or PNG format together with the authorization number.
3. WHERE the Raffle Jurisdiction is a United States state, THE Compliance_Service SHALL require the Owner to declare, before publication, the Owner's eligibility under that state's raffle law (for example, registered charitable organization status) and to upload each license document required by that state's rule set, as a file of at most 10 MB in PDF, JPG, or PNG format.
4. IF the Raffle configuration violates the Jurisdiction rule set, THEN THE Compliance_Service SHALL block publication, keep the Raffle in its current non-published status, retain the Owner's entered data, and display, within 2 seconds, each unmet rule by name together with the configured value that was violated.
5. IF the Owner has not provided the required compliance evidence at publication request, THEN THE Raffle_Service SHALL set the Raffle status to pending_review, and THE Back_Office SHALL add the Raffle to the Admin review queue within 5 seconds of the status change.
6. WHEN a Player or visitor opens a Share_Page, THE Share_Page SHALL display the disclosures required by the Raffle Jurisdiction rule set, including at minimum Owner identity, authorization or license number, prize description, and draw method.
7. IF a Player's declared location or IP-based geolocation resolves to a Jurisdiction that is not enabled for the Raffle, THEN THE Compliance_Service SHALL reject the purchase, create no Ticket reservation or charge, and display a message stating that purchases are unavailable in the Player's location.
8. WHEN an Admin enables a new Jurisdiction in the Back_Office, THE Platform SHALL apply the rule set of that Jurisdiction only to Raffles created after the enablement time and SHALL leave existing Raffles unchanged.
9. WHEN a Raffle Payout is completed or a reporting period defined in the Jurisdiction rule set ends, THE Platform SHALL generate the Payout summary for the Owner and the tax authority reporting data required by that Jurisdiction, and make them available for download in the Back_Office within 60 seconds.
10. IF the Platform fails to generate a tax or reporting document, THEN THE Platform SHALL mark the document as failed, notify an Admin in the Back_Office, and retry generation up to 3 times at 5-minute intervals.

### Requirement 13: Identity and Age Verification (KYC)

**User Story:** As the Platform operator, I want to verify the identity of Owners and the age of Players, so that the Platform prevents fraud and underage participation.

#### Acceptance Criteria

1. WHEN an Owner submits a Raffle for publication, THE Compliance_Service SHALL require the Owner to complete KYC, including legal name, government identification (cédula de ciudadanía, cédula de extranjería, NIT, or US government ID or EIN), and a verified selfie or document check through a KYC provider.
2. IF Owner KYC fails or is rejected, THEN THE Compliance_Service SHALL block Raffle publication, retain the Raffle in draft state with its entered data preserved, show the Owner the rejection reason and the retry steps, and allow the Owner to resubmit KYC up to 3 times within 24 hours.
3. IF the KYC provider does not return a result within 30 seconds or is unavailable, THEN THE Compliance_Service SHALL block Raffle publication, show the Owner an error indicating that verification could not be completed, and allow the Owner to retry.
4. WHEN a Player registers, THE Platform SHALL require the Player to confirm a date of birth that shows the Player is at least 18 years old on the date of registration.
5. IF a Player's date of birth shows an age below 18 years on the date of registration, THEN THE Platform SHALL block registration and Ticket purchase, show the Player a message indicating the minimum age requirement, and not create the Player account.
6. WHERE a Jurisdiction rule requires document-based age verification for Players, THE Compliance_Service SHALL block the first Ticket purchase until the verification is approved by the KYC provider.
7. WHEN a Player wins a Raffle with a prize value above a configurable threshold, THE Compliance_Service SHALL require identity verification of the Player before the Owner is told to deliver the prize.
8. IF the Player's identity verification for a winning Raffle is rejected or not completed within 30 days of the draw, THEN THE Compliance_Service SHALL withhold the delivery notification to the Owner and notify the Player and an Admin that the verification is outstanding.
9. THE Platform SHALL store KYC documents encrypted and accessible only to authorized Admins and the KYC provider.

### Requirement 14: Owner Payouts

**User Story:** As an Owner, I want to receive the money from ticket sales, so that I can fund the prize and my organization.

#### Acceptance Criteria

1. THE Platform SHALL calculate Owner net proceeds as total confirmed Ticket sales minus refunds, Platform_Commission, Payment_Provider fees, and taxes withheld, expressed in the Raffle currency with a precision of 2 decimal places.
2. WHEN an Owner with approved KYC submits a payout account, THE Platform SHALL register the account as the Owner's payout account for the Raffle country, accepting only a Colombian bank account for Raffles in Colombia or a US bank account for Raffles in the United States.
3. IF an Owner submits a payout account that does not match the Raffle country, or whose account details fail validation, THEN THE Platform SHALL reject the account, retain any previously registered payout account, and display an error indicating the reason for rejection.
4. WHEN a Raffle reaches completed status and the winner is recorded, THE Payment_Service SHALL release the Payout after a configurable holding period of 1 to 30 business days, with a default of 3 business days.
5. IF a dispute or chargeback is open on a Raffle, THEN THE Payment_Service SHALL withhold the amount of the disputed payments from the Payout until the dispute is resolved, and SHALL release the remaining undisputed amount after the holding period.
6. WHEN a Payout is released, THE Notification_Service SHALL send the Owner a payout statement within 5 minutes, listing sales, refunds, commission, fees, taxes withheld, and net amount.
7. IF a Payout transfer fails, THEN THE Payment_Service SHALL flag the Payout in the Back_Office, notify the Owner within 1 hour, and retain the Payout amount unreleased until the transfer succeeds or is cancelled by a Back_Office user.
8. WHERE the Jurisdiction rule set requires tax withholding, THE Platform SHALL withhold taxes from the Payout at the rate and basis defined by the Jurisdiction rule set for the Raffle country.
9. FOR ALL Raffles, THE Payment_Service SHALL maintain the invariant that the Payout amount plus Platform_Commission plus provider fees plus withheld taxes plus refunds plus any amount withheld for open disputes equals total confirmed Ticket sales.

### Requirement 15: Fraud Prevention and Security

**User Story:** As the Platform operator, I want to detect and stop fraudulent activity, so that Owners, Players, and the Platform are protected.

#### Acceptance Criteria

1. WHEN a purchase is initiated, THE Fraud_Service SHALL calculate a risk score as an integer from 0 to 100 within 2 seconds, using signals including device, IP address, velocity of purchases, and payment history.
2. IF the risk score is greater than or equal to the configured block threshold, THEN THE Fraud_Service SHALL reject the purchase, record the reason and the risk score, release any Reservation held for that purchase, and display to the Player an error indicating the purchase could not be completed.
3. IF the risk score is greater than or equal to the review threshold and less than the block threshold, THEN THE Fraud_Service SHALL hold the order, queue it for Admin review within 5 seconds, and notify the Player that the order is under review.
4. IF the Fraud_Service does not return a risk score within 5 seconds or returns an error, THEN THE Platform SHALL hold the order, queue it for Admin review, and notify the Player that the order is under review.
5. IF a user or IP address submits more than 10 Reservation creation requests within any 60-second period, THEN THE Platform SHALL reject each additional request until the period ends and display an error indicating the rate limit was exceeded and the time remaining before the next request is allowed.
6. WHEN the Fraud_Service detects a Raffle with signals of fraud (for example, a prize that does not exist or duplicated identities), THE Fraud_Service SHALL suspend new sales on the Raffle within 60 seconds, notify all Admins, and preserve orders already completed.
7. THE Platform SHALL require HTTPS (TLS 1.2 or later) for all connections and SHALL refuse connections that use earlier protocol versions or no encryption.
8. THE Platform SHALL protect against cross-site scripting, cross-site request forgery, and SQL injection by rejecting any request that carries unsanitized script content in user-supplied input, lacks a valid anti-forgery token on state-changing actions, or carries input that alters database query structure.
9. WHERE an Owner is flagged as high risk, THE Compliance_Service SHALL require manual Admin approval before each Raffle published by that Owner becomes visible to Players.
10. WHEN a user selects the "report this raffle" action on the Share_Page and submits a report with a reason of 1 to 1000 characters, THE Platform SHALL send the report to the Back_Office within 5 seconds and display a confirmation to the user.
11. IF a "report this raffle" submission has an empty reason or a reason longer than 1000 characters, THEN THE Platform SHALL reject the submission, retain the entered text, and display an error indicating the allowed length.

### Requirement 16: Share Page, QR Code, and Social Sharing

**User Story:** As an Owner, I want a public page and QR code for my raffle, so that I can promote it and Players can join easily.

#### Acceptance Criteria

1. WHEN a Raffle is published, THE Platform SHALL generate a unique Share_Page URL for the Raffle containing a randomly generated token of at least 128 bits of entropy that is not derived from the Raffle's sequential identifier, title, or Owner information.
2. WHEN a Raffle is published, THE Platform SHALL generate a QR code that encodes the Share_Page URL and make it available to the Owner for download in PNG format and in SVG format.
3. WHEN the Owner requests a QR code download, THE Platform SHALL deliver a PNG file with a minimum dimension of 1024 by 1024 pixels or an SVG file, and the scanned QR code SHALL resolve to the Share_Page URL.
4. WHEN a visitor opens the Share_Page, THE Platform SHALL display the prize, Raffle images, Ticket price, available Ticket count, deadline countdown, External_Lottery, Winning_Rule, Owner identity, and legal disclosures.
5. WHILE the Raffle deadline has not passed, THE Share_Page SHALL update the deadline countdown at least once every 1 second and SHALL update the available Ticket count within 5 seconds of a change in availability.
6. WHEN the Share_Page is requested, THE Platform SHALL include Open Graph metadata containing the Raffle title (maximum 70 characters), a Raffle image of at least 1200 by 630 pixels, and a description (maximum 200 characters), so that social networks and messaging apps display all three.
7. WHEN a visitor who is not signed in opens the Share_Page, THE Platform SHALL display the full Raffle content without requiring sign-in.
8. WHEN a visitor who is not signed in starts checkout, THE Platform SHALL require sign-in and, after successful sign-in, return the visitor to checkout for the same Raffle with the selected Tickets preserved.
9. IF a visitor opens a Share_Page URL that does not match any Raffle or whose Raffle is not published, THEN THE Platform SHALL display a not-found page that indicates the Raffle is unavailable and SHALL NOT reveal whether the Raffle exists.
10. WHERE the Owner purchased the custom branding option, THE Share_Page SHALL display the Owner logo and the Owner-selected theme colors.
11. THE Share_Page SHALL render all text, dates, and currency amounts in the Locale selected by the visitor, and SHALL fall back to the Platform default Locale for any text without a translation in the selected Locale.

### Requirement 17: Owner Analytics Dashboard

**User Story:** As an Owner, I want to see sales and engagement data, so that I can manage and promote my raffle.

#### Acceptance Criteria

1. WHEN an Owner opens the Analytics_Dashboard for a Raffle, THE Analytics_Dashboard SHALL display for that Raffle the count of Tickets sold, the count of Tickets available, the count of Tickets reserved, gross sales, total refunds, and net proceeds, where net proceeds equals gross sales minus total refunds, all monetary values shown in the Raffle currency to 2 decimal places.
2. WHEN an Owner opens the Analytics_Dashboard for a Raffle, THE Analytics_Dashboard SHALL display the count of Share_Page visits, the count of checkout starts, the count of completed purchases, the conversion rate from Share_Page visits to checkout starts, and the conversion rate from checkout starts to completed purchases, each rate expressed as a percentage to 1 decimal place.
3. IF the count of Share_Page visits or checkout starts is 0, THEN THE Analytics_Dashboard SHALL display the dependent conversion rate as 0.0% and SHALL NOT display an error.
4. WHEN an Owner opens the Analytics_Dashboard for a Raffle, THE Analytics_Dashboard SHALL display a time series of Tickets sold and gross sales per calendar day, from the Raffle start date through the earlier of the current date or the Raffle end date, using 0 for days with no sales.
5. WHEN an Owner opens the Analytics_Dashboard for a Raffle, THE Analytics_Dashboard SHALL display the count of completed purchases and gross sales for each traffic source, where the traffic sources are direct, QR code, and referral link, and the counts across sources sum to the total completed purchases.
6. WHEN a sale is confirmed, THE Analytics_Dashboard SHALL update all displayed metrics to include that sale within 60 seconds.
7. WHEN an Owner requests a report export, THE Platform SHALL provide the metrics displayed on the Analytics_Dashboard for the selected Raffle as a downloadable CSV file within 10 seconds.
8. IF the CSV export fails, THEN THE Platform SHALL display an error message indicating the export failed, SHALL provide no partial file, and SHALL leave the Analytics_Dashboard data unchanged.
9. THE Analytics_Dashboard SHALL show Player personal data only to the Owner of that Raffle, limited to the fields needed for prize delivery and Raffle administration (name, contact email, and contact phone number, and delivery address where the prize requires delivery).
10. IF a user other than the Owner of a Raffle requests that Raffle's Analytics_Dashboard data or export, THEN THE Platform SHALL deny the request, display an error message indicating access is not permitted, and SHALL disclose no Raffle metrics or Player personal data.

### Requirement 18: Audit Trail

**User Story:** As an Admin, I want a tamper-evident record of key events, so that I can resolve disputes and demonstrate compliance.

#### Acceptance Criteria

1. WHEN any of these events occurs, THE Audit_Service SHALL record an audit event for it: Raffle creation, Raffle change, status change, payment, refund, Payout, draw result retrieval, winner determination, KYC decision, Admin action, and manual data override.
2. WHEN THE Audit_Service records an audit event, THE Audit_Service SHALL include the actor identifier, action, affected entity type and identifier, timestamp in UTC with millisecond precision, and the prior and new values of each changed field.
3. THE Audit_Service SHALL store the Audit_Trail in an append-only form that rejects every attempt by any user, including Admin users, to update or delete a recorded event.
4. IF a user attempts to update or delete a recorded audit event, THEN THE Audit_Service SHALL reject the attempt, leave the recorded event unchanged, and record a new audit event for the rejected attempt.
5. WHEN an Admin searches the Audit_Trail by Raffle, user, event type, or date range, THE Back_Office SHALL return the matching events, sorted by timestamp in descending order, within 5 seconds for result sets of up to 10,000 events.
6. IF an Admin search of the Audit_Trail matches no events, THEN THE Back_Office SHALL return an empty result with an indication that no events matched.
7. THE Audit_Service SHALL retain each Audit_Trail event for at least 7 years from the event timestamp.
8. WHEN THE Audit_Service records an audit event, THE Audit_Service SHALL store with it a hash computed from the event content and the hash of the immediately preceding event, so that modification, removal, or reordering of any event is detectable.
9. IF THE Audit_Service cannot record an audit event for an operation listed in criterion 1, THEN THE Audit_Service SHALL cause that operation to fail, leave the operation's data unchanged, and return an error indicating the audit record could not be written.

### Requirement 19: Admin Back Office

**User Story:** As an Admin, I want an operations console, so that I can review, support, and control the Platform.

#### Acceptance Criteria

1. IF a user is not authenticated as an Admin, or has not completed multi-factor authentication in the current session, THEN THE Back_Office SHALL deny access to all Back_Office functions and display an access-denied indication without revealing any Back_Office data.
2. THE Back_Office SHALL enforce role-based permissions with the roles Support, Compliance, Finance, and Super Admin, and each Admin SHALL be assigned at least one role.
3. IF an Admin attempts an action not permitted by any of the Admin's assigned roles, THEN THE Back_Office SHALL reject the action, leave all data unchanged, and display an error indicating insufficient permissions.
4. WHEN a Compliance Admin approves or rejects a Raffle in pending_review, THE Back_Office SHALL require a reason of 1 to 1,000 characters, record the decision, reason, Admin identity, and timestamp, and change the Raffle status accordingly.
5. IF a Compliance Admin submits an approval or rejection with an empty reason or a reason longer than 1,000 characters, THEN THE Back_Office SHALL reject the submission, keep the Raffle in pending_review, and display an error indicating the reason requirement.
6. THE Back_Office SHALL let Finance Admins view payments, refunds, Payouts, and failed transfers, and retry failed refunds and Payouts.
7. IF a retry of a failed refund or Payout fails, THEN THE Back_Office SHALL keep the item in failed status, record the failure with its timestamp, and display an error indicating the retry failed.
8. WHEN an Admin suspends or reinstates a Raffle, an Owner, or a Player, THE Back_Office SHALL require a reason of 1 to 1,000 characters, record the action, reason, Admin identity, and timestamp, and apply the new status.
9. THE Back_Office SHALL let Super Admins configure fees, Platform_Commission, supported External_Lotteries, Jurisdiction rule sets, and Reservation_Timeout defaults, and record each change with the previous value, new value, Admin identity, and timestamp.
10. THE Back_Office SHALL let Admins view and respond to Raffle reports and support cases.
11. WHEN an Admin enters a manual draw result, THE Back_Office SHALL hold the result as pending and apply it only after a second Admin, different from the entering Admin, approves it.
12. IF the entering Admin attempts to approve their own manual draw result, or a second Admin rejects it, THEN THE Back_Office SHALL not apply the result, keep the Raffle's draw state unchanged, and record the outcome with Admin identity and timestamp.

### Requirement 20: Localization (English and Spanish)

**User Story:** As a user in Colombia or the US, I want to use the app in English or Spanish, so that I understand every part of it.

#### Acceptance Criteria

1. THE PWA_Client SHALL provide every user-facing string in both English and Spanish, including validation messages, error messages, emails, SMS, receipts, legal disclosures, and Share_Page content.
2. WHEN a user first visits the Platform with no stored Locale preference, THE PWA_Client SHALL select Spanish if the primary browser language tag begins with "es", SHALL select English if it begins with "en", and SHALL select English for any other language.
3. WHEN a user selects a Locale, THE PWA_Client SHALL apply the Locale to all visible text within 1 second, SHALL preserve all unsubmitted form input and the current page position, and SHALL store the preference in the user profile.
4. IF storing the Locale preference in the user profile fails, THEN THE PWA_Client SHALL keep the selected Locale for the current session, SHALL display an error message indicating the preference was not saved, and SHALL allow the user to retry.
5. THE Platform SHALL format currency amounts, dates, times, and numbers according to the selected Locale conventions, and SHALL display currency amounts in the Raffle currency (COP or USD) regardless of the selected Locale.
6. WHEN THE Platform sends an outbound notification (email or SMS) to a user, THE Platform SHALL send it in the Locale stored in that user's profile, or in English if no Locale is stored.
7. IF a translation key is missing in the selected Locale, THEN THE PWA_Client SHALL display the English text for that key and THE Platform SHALL log the missing key name and Locale, at most once per key and Locale per session.
8. THE Platform SHALL store all user-facing text in resource files separate from application code.
9. WHERE an Owner provides Raffle content (title, description, and prize details), THE PWA_Client SHALL let the Owner enter both English and Spanish versions of each field, and SHALL display the version matching the visitor Locale.
10. IF the Raffle content for a field is missing in the visitor Locale, THEN THE PWA_Client SHALL display the version in the other language for that field.

### Requirement 21: Progressive Web App Capabilities

**User Story:** As a mobile user, I want to install and use the app like a native app, so that I can access raffles quickly.

#### Acceptance Criteria

1. THE PWA_Client SHALL provide a web app manifest and a service worker so that browsers supporting installation can offer an "add to home screen" option for the app.
2. WHILE the device has no network connectivity, THE PWA_Client SHALL display each Raffle page that was loaded successfully within the previous 7 days, together with a visible message stating that purchases require a connection.
3. IF the device has no network connectivity AND the user opens a Raffle page that was not previously loaded or was loaded more than 7 days ago, THEN THE PWA_Client SHALL display an offline notice indicating the page is unavailable without a connection, and SHALL NOT display an empty or broken page.
4. IF the device has no network connectivity AND the user attempts to start a purchase, THEN THE PWA_Client SHALL block the purchase attempt, display a message indicating that a connection is required, and preserve the user's current selections (such as chosen numbers) in the page.
5. THE PWA_Client SHALL render layouts for screen widths from 320 px to 1920 px with no horizontal scrolling of the page and with all interactive controls fully visible and operable.
6. WHERE the user grants web push permission, THE PWA_Client SHALL deliver web push notifications as an additional channel for non-mandatory notification types only.
7. IF the user denies or revokes web push permission, THEN THE PWA_Client SHALL stop delivering web push notifications and SHALL continue to deliver all notifications through the other existing channels.
8. THE PWA_Client SHALL achieve a Lighthouse performance score of at least 80 for the Share_Page, measured with the Lighthouse mobile preset (simulated Moto G-class device, slow 4G throttling) as the median of 5 consecutive runs.
9. WHEN a new version of the PWA_Client becomes available, THE PWA_Client SHALL display a prompt offering the user a refresh action within 5 seconds of detecting the new version.
10. WHEN the user selects the refresh action in the update prompt, THE PWA_Client SHALL reload and activate the new version within 3 seconds, excluding network transfer time.

### Requirement 22: Accessibility

**User Story:** As a user with a disability, I want to use the platform with assistive technology, so that I can participate equally.

#### Acceptance Criteria

1. THE PWA_Client SHALL conform to all WCAG 2.1 Level A and Level AA success criteria in both Locales, where conformance is verified by an automated accessibility scan reporting zero violations plus a manual review with at least one screen reader per supported platform.
2. THE PWA_Client SHALL allow every interactive function to be completed using the keyboard alone, with no keyboard traps and a logical focus order matching visual reading order.
3. WHILE an interactive element has keyboard focus, THE PWA_Client SHALL display a visible focus indicator with a contrast ratio of at least 3:1 against adjacent colors and a minimum thickness of 2 CSS pixels.
4. THE PWA_Client SHALL provide a text alternative of at most 150 characters in the active Locale for each informative image, including prize images and QR codes, and an empty text alternative for purely decorative images.
5. THE PWA_Client SHALL provide a contrast ratio of at least 4.5:1 for normal text and at least 3:1 for large text (at least 24 CSS pixels, or at least 18.66 CSS pixels bold) and for user interface component boundaries.
6. WHEN a Ticket status changes, a form error is displayed, or the Reservation countdown reaches each of the following remaining times: 5 minutes, 1 minute, and 10 seconds, THE PWA_Client SHALL announce the change to screen readers through an ARIA live region within 1 second.
7. THE PWA_Client SHALL provide an accessible alternative to the Ticket selection grid, offering both a list view and a number input, that is operable without pointer interaction and produces the same selection result as the grid.
8. IF a Share_Page theme color combination produces a text contrast ratio below 4.5:1, THEN THE PWA_Client SHALL reject the theme, retain the previously applied theme, and display an error message identifying the failing color pair and the measured contrast ratio.

### Requirement 23: Privacy and Data Protection

**User Story:** As a user, I want my personal data protected and under my control, so that I can trust the platform.

#### Acceptance Criteria

1. WHERE a user is in Colombia, THE Platform SHALL comply with Colombian Law 1581 of 2012 and its regulations on personal data protection.
2. WHERE a user is a resident of a US state with a consumer privacy law (for example, California CCPA/CPRA), THE Platform SHALL provide the rights that law grants.
3. WHEN a user registers, THE Platform SHALL present a privacy policy and terms of service in the selected Locale and record the acceptance with version identifier, user identifier, and timestamp (UTC, to the second).
4. IF a user does not accept the privacy policy and terms of service during registration, THEN THE Platform SHALL reject the registration, create no user account, and display a message indicating that acceptance is required.
5. WHEN an authenticated user requests a copy of personal data, THE Platform SHALL provide an export in a machine-readable format within 30 days of the request and confirm receipt of the request to the user within 24 hours.
6. WHEN an authenticated user requests deletion of personal data, THE Platform SHALL delete or anonymize the data within 30 days of the request, except data that legal retention rules require, and inform the user which data categories were retained and the reason.
7. IF an export or deletion request cannot be completed within 30 days, THEN THE Platform SHALL notify the user of the failure and the reason before the 30-day period ends and notify the Admin.
8. THE Platform SHALL encrypt personal data at rest and in transit.
9. THE Platform SHALL collect only the personal data needed for the functions defined in this document.
10. IF a user has not given consent, THEN THE Platform SHALL not send marketing messages to that user and SHALL not set non-essential analytics cookies in that user's browser.
11. WHEN a user withdraws consent, THE Platform SHALL stop marketing messages and non-essential analytics cookies for that user within 24 hours.
12. IF a personal data breach is detected, THEN THE Platform SHALL notify the Admin security contact within 1 hour of detection and notify affected users and authorities within the period required by the applicable Jurisdiction.
13. THE Platform SHALL show Player names on the public Share_Page only in abbreviated form (first name and last initial) and only after the Player agrees.
14. IF a Player has not agreed to name display or withdraws agreement, THEN THE Platform SHALL show that Player on the public Share_Page as anonymous, with withdrawal taking effect within 24 hours.

### Requirement 24: Disputes and Support

**User Story:** As a Player or Owner, I want to report problems and get help, so that issues are solved fairly.

#### Acceptance Criteria

1. WHEN a Player or Owner submits a support case related to a Raffle, payment, or draw, THE Platform SHALL create the case, link it to the referenced Raffle, payment, or draw, and make it visible to the requester in their case list.
2. WHEN a support case is opened, THE Platform SHALL send the requester a confirmation containing a unique case number within 60 seconds.
3. IF a support case submission is missing the case type or the referenced Raffle, payment, or draw, or the description exceeds 2,000 characters, THEN THE Platform SHALL reject the submission, indicate which field is invalid, and retain the data the requester entered.
4. WHEN a Player disputes the winner determination, THE Back_Office SHALL show the Admin the External_Lottery result, the Winning_Rule, and the derived number from the Audit_Trail on the dispute case view.
5. IF the Audit_Trail has no External_Lottery result, Winning_Rule, or derived number for a disputed Raffle, THEN THE Back_Office SHALL show the Admin an indication of which item is missing and mark the dispute case as requiring investigation.
6. WHEN a payment provider reports a chargeback, THE Payment_Service SHALL link the chargeback to the Raffle, notify Finance Admins within 60 seconds, and apply the Payout hold in Requirement 14.
7. WHEN an Owner confirms prize delivery or an Admin records delivery, THE Raffle_Service SHALL record the delivery status, the timestamp, and the identity of the confirming Owner or recording Admin on the Raffle.
8. IF an Owner does not confirm prize delivery within 30 days of the winner announcement, THEN THE Notification_Service SHALL send a reminder to the Owner and an alert to Admins within 1 hour of the 30-day deadline passing.

### Requirement 25: Reliability and Performance

**User Story:** As a user, I want the platform to remain fast and available at draw and deadline times, so that I can rely on it.

#### Acceptance Criteria

1. THE Platform SHALL maintain a monthly availability of at least 99.9% for ticket purchase and Share_Page functions, measured as the percentage of one-minute intervals in a calendar month in which a health check of each function succeeds, excluding scheduled maintenance announced at least 24 hours in advance.
2. WHILE 1,000 concurrent visitors are requesting Share_Pages, THE Platform SHALL respond to at least 95% of Share_Page requests within 2 seconds, measured from request receipt to the last byte of the response sent.
3. WHEN multiple Players request reservation of the same Ticket at the same time, THE Platform SHALL grant the Reservation to exactly one Player and reject all other requests with an indication that the Ticket is unavailable, so that no Ticket is Sold to more than one Player.
4. THE Platform SHALL perform automated backups of data at least once every 24 hours and SHALL support restoration to a state no more than 1 hour older than the moment of failure (recovery point objective of 1 hour).
5. IF an integration with a Payment_Provider, External_Lottery source, or messaging provider is unavailable, THEN THE Platform SHALL queue the affected operation, retry it with exponential backoff up to 3 attempts, preserve the queued operation without data loss between attempts, and alert Admins after the 3rd failed attempt.
6. WHEN a service restarts, THE Platform SHALL resume scheduled jobs for deadline closure, Reservation expiry, and draw retrieval so that each job is executed exactly once per scheduled occurrence, with no occurrence skipped or duplicated.
7. IF the Platform rejects a Ticket reservation request because the Ticket is no longer available, THEN THE Platform SHALL leave the Ticket state unchanged and display a message to the Player indicating that the Ticket is unavailable.

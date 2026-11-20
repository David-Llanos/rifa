-- Creation_Fee and Customization_Fee payments (Requirements 3.1 to 3.9).
-- Fee payments share the payment table with ticket payments; `purpose` tells them apart. The amount
-- is stored when the payment is initiated, so later fee changes never alter it (Requirement 3.8).
ALTER TABLE payment
  ADD COLUMN purpose text NOT NULL DEFAULT 'ticket'
    CHECK (purpose IN ('ticket', 'creation_fee', 'customization')),
  ADD COLUMN customization_option text
    CHECK (customization_option IN ('branding', 'share_theme', 'extra_prize_images', 'notification_templates'));

ALTER TABLE payment ADD CONSTRAINT payment_purpose_shape CHECK (
  (purpose = 'ticket' AND customization_option IS NULL)
  OR (purpose = 'creation_fee' AND customization_option IS NULL AND order_id IS NULL)
  OR (purpose = 'customization' AND customization_option IS NOT NULL AND order_id IS NULL)
);

CREATE INDEX payment_fee_lookup_idx ON payment (raffle_id, purpose, customization_option, status)
  WHERE purpose <> 'ticket';

-- Set when the Creation_Fee payment succeeds; submission requires it.
ALTER TABLE raffle ADD COLUMN creation_fee_payment_id uuid REFERENCES payment (id);

-- raffle.customizations (0001) holds the Owner's selection:
--   [{"option": "branding", "enabled": false}, {"option": "share_theme", "enabled": true, "paymentId": "..."}]
-- An option is enabled only after its fee payment succeeds (Requirement 3.5).

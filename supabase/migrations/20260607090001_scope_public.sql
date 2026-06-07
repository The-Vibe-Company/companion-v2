-- Add a 4th visibility scope: `public` ("anyone with the link"). Must be added in its
-- own migration (a new enum value cannot be used in the same transaction it is added).
alter type scope add value if not exists 'public';

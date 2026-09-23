<!-- version: 2.69.1 -->
This is a security update and updating is recommended. It closes two places where an ordinary household member could reach further than their role allows.

Only admins can manage CardDAV contact accounts now. Until this release, a member could change the server address of a household CardDAV account, and the next sync sent the stored credentials to that server. Members keep reading and editing contacts as before.

The first single sign-on of a household member can no longer be steered by another member through their own profile email address. If you use SSO: a member whose account has a password and is not yet linked to SSO is no longer linked by email address. Their first SSO sign-in shows a message asking them to sign in with their password and link SSO under Settings, Account. Alternatively, an admin can switch the account to "SSO sign-in only" under Settings, Administration, Family. Accounts that are already linked are not affected.

There are no database changes in this update.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.69.1

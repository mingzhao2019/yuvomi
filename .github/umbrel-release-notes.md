<<<<<<< HEAD
<!-- version: 2.65.2 -->
This is a security release, and it changes nothing about how Yuvomi looks or works day to day. It concerns API tokens that are limited to single modules, such as a token handed to an AI assistant or an MCP client. A token allowed to use the global search could read matching notes, contacts and medications through it, and a token allowed to read the dashboard received the data of every tile, although neither had been given those modules. Both now leave out every module the token was not given. Browser sessions and tokens without module limits see no change.
=======
<!-- version: 2.66.2 -->
This is a security update and changes nothing else. It closes a gap in single sign-on: an account for housekeeping staff, which has never been allowed to sign in with a password, could still get in through your SSO provider and end up with a full household member's session. Only households that have single sign-on configured were affected. If you use SSO and keep staff accounts, update soon.
>>>>>>> 35f2f80b (chore: release v2.66.2)

One thing to check after updating: a token that was given only the search or the dashboard scope now returns empty results until you add the modules it should be able to read.

<<<<<<< HEAD
Nothing changes in the database with this update, so it is a plain container swap with no migration to wait for.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.65.2
=======
Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.66.2
>>>>>>> 35f2f80b (chore: release v2.66.2)

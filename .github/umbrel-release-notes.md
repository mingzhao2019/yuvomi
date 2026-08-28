<!-- version: 2.50.1 -->
A small hardening release, with nothing to do by hand after the update.

The setup wizard no longer accepts a public address without an http:// or https:// scheme. An address typed as "yuvomi.example.com" used to be written to the configuration exactly like that, which quietly broke password-reset emails and the sign-in addresses shown for Google and Microsoft. Until a full address is entered, the wizard now keeps the one it derives from host and port. Running installations only meet this when the wizard is re-run.

The rest resolves the findings of an automated security review of the code: a server-side address check that could be made needlessly slow now runs in plain steps, and several internal checks match precisely instead of loosely.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.50.1

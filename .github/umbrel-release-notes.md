<!-- version: 2.80.0 -->
This update makes every module behave the same way and adds Traditional Chinese as the 27th language.

Switching between sections is now instant, long task and shopping lists open faster, and back and forward return to where you were in every list. Dialogs use one kind of switch, mark every required field and start in the right field. Status actions such as ticking off or archiving say what they did and can be undone, instead of asking first. Dates, times and amounts read the same in every module, and the year is left out when it is this year.

Contacts with a birthday can be added to Birthdays straight from their detail view, and a birthday can be linked to a contact by hand. A new "First steps" card follows the welcome tour. Calendar sync has its own settings page, shifts appear as time blocks in the calendar, and fasting now starts from the add button. Traditional Chinese covers the app and both installers, and TWD, HKD and MOP can be picked as currencies.

Several fixes are included: an amount typed with a thousands separator is no longer saved as a fraction of it, deleting a budget account no longer touches other members' private entries, putting the shopping away no longer duplicates pantry items, and SSO sign-in with Gitea works again.

One database migration runs automatically on first start: child accounts created before the previous version start without the cycle tab in Health, as new child accounts already do. The child can turn it back on. No action is needed. As always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.80.0

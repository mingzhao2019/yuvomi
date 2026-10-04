<!-- version: 2.72.0 -->
This update closes several privacy gaps between members of a household, adds Norwegian Bokmål, and fixes a long list of things people reported after 2.71.0.

On the security side, ticking off, reopening or archiving a task now respects its visibility, reminders can only be set on entries you can see, and the points history no longer names a task that is hidden from you. In personal budget mode, the entry list and the budget plan no longer reveal what another member keeps private. A recurring shared expense is now checked when it is created, and one that cannot be booked is paused on its own instead of holding back every other recurring expense. Updating is recommended for every household with more than one member.

Norwegian Bokmål is the 26th language. Admins are asked once whether the household should use the browser's time zone, and a new household starts in its own time zone. Korean sentences now pick the right particle for the name they contain, and avatars show the same initials for a person on every page.

Recurring tasks say when they come back after you tick them off, and give their points once a day instead of once per tick; reopening a completed task no longer erases its points from the history. In the calendar, opening one occurrence of a recurring event opens that occurrence, an event that ends at midnight is drawn at its full length, and right-to-left languages are mirrored fully. An address that does not exist now takes you to the closest page.

The update runs two database migrations on first start. One gives every recurring budget payment its own start date, the other changes how points are reversed when a task is reopened. No existing entry is lost and no action is needed; as always, a backup before updating is a good idea.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.72.0

# Changelog

Every release that changed something you could see or click. Newest first.
Older releases than 1.8.0 did not keep a changelog; the [README](./README.md) describes what the
extension does today, which is a better guide to those versions than a list I would have to invent.

## [1.13.0] - 2026-10-19

- Added: a "Never stash these" list under Settings → General. It decides which pages a stash leaves
  alone. Its own pages and the two store consoles can now be included if you want them, and you can
  add your own URL prefixes. The list is folded away by default, and a line at the top of the panel
  says which prefixes are currently never stashed and which ones will be stashed.
- Changed: the brand green is now the same one as the sibling project — icon, UI accents and store
  images all moved together. White text on it still clears the contrast threshold.
- Removed: the version line at the bottom of the settings sidebar. The version still shows on the
  About page.
- Fixed: checking an internal scheme such as `chrome://` in that list no longer unchecks itself
  after a page reload. (Chrome's URL parser rejects `chrome://`; the old check relied on it.)

## [1.12.1] - 2026-10-18

- Added: the extension is listed on the Chrome Web Store and Edge Add-ons. From this version on,
  the store listing moves in step with the GitHub/Gitee packages — once you install from a store
  you get updates inside the browser instead of downloading a zip and loading it by hand.
  Submissions are sent automatically by the release pipeline and go live when review passes.
- Changed: the three images on the About page (two sponsor codes and one official-account banner)
  are no longer inside the package; they load from a shared image repository when you open that
  page (GitHub and Gitee mirrors, whichever answers first). The package shrank from about 376 KB
  to about 171 KB. The cost, stated plainly: with no network those three images show
  "couldn't load, retry" — the images themselves are byte-for-byte the same ones, what changed
  is where they come from.

## [1.12.0] - 2026-10-16

- Added: **Restore this version** is now a *replacement*, and it takes two clicks. The first click
  only shows you what would happen — how many sessions come back, how many get swapped out, and
  that the other machine will change too. The second click writes it. The confirmation bar scrolls
  itself into view, so it never sits off-screen above a long list.
- Added: the remote history now has a ceiling — the last 100 versions are kept and anything older
  is deleted automatically (at most 20 versions per round, the rest carry over to the next round).
  Before this nothing was ever deleted, so after a few months the only way to make room was to
  scroll past the entire list to find the cleanup button.
- Fixed: two machines left open side by side no longer push each other into syncing. The symptom
  was ten new versions in nine minutes — and every one of them burned a request against your
  storage quota. The cause was that "in which order should the same pile of content be written
  down" had three separate answers in the code; now there is exactly one.
- Fixed: tombstones left behind by an earlier *restore this version* no longer block the next one.
  Restoring two versions in a row used to dump a wall of conflict cards on you. Deletions you made
  yourself are still asked about — that guard is unchanged.
- Fixed: conflict cards now carry names. The heading is the session's title instead of a bare
  hexadecimal identifier, and it is recorded at the moment the conflict is written, so it shows up
  even on the machine that never had that session locally.
- Fixed: the line telling you what a cleanup just did (how many versions deleted, how many kept)
  appears above the list, where you can see it, instead of below a list that can be pages long.
- Changed: the sync log block has its own height cap and scrolls inside itself, so one long log no
  longer stretches the whole settings page into that one section. Scrolling to its end no longer
  drags the page along with it.
- Changed: the remote history lists 20 versions per screen and *Show earlier* pages through them
  locally — it does not send a single extra request.
- Changed: the WebDAV location lost one layer of folder. It is now `<your address>/ShiTab/`.
  The cost, stated plainly: versions pushed before this change are not found at the new location
  (the old folder is still on your drive, untouched, and only you can delete it), and each machine
  starts counting revisions from scratch.
- Added: from this version on, every release ships a loadable extension package (a zip for
  Chrome and Edge) plus its checksum, on both the GitHub and Gitee release pages. These two
  changelog files start here as well.

## [1.11.0] - 2026-10-08

- Fixed: stashing no longer touches pages a browser refuses to reopen later — extension pages,
  `chrome://` / `edge://` pages, blank tabs. They are neither saved into the session nor closed;
  they simply stay where they are.
- Added: a sync log and device names. The log records only the five things that actually happened
  (push, pull, conflict, problem, error) and writes nothing at all for an idle round; device names
  are yours to edit, and the other machine shows the name rather than the first eight characters of
  a UUID.
- Changed: five repairs to the sync trunk. The "your machine holds far fewer groups than the
  server" notice now has a way out — after you have checked the four numbers you can explicitly
  approve that exact version; every network request has a timeout now; the payload on the wire is
  genuinely compressed; "which version is the newest" is read from a small fixed-name pointer file
  instead of listing a directory every round; and two machines writing at the same time can no
  longer overwrite each other's manifest.
- Note: the docs gained a *why this exists* section, and all three outward documents were
  rewritten in the first person.

## [1.10.0] - 2026-10-07

- Added: two context menus now offer six stashing scopes. One more permission (`contextMenus`) is
  requested, and neither installation nor upgrade shows an extra warning prompt.
- Added: `privacy.html`, in both languages, so the store listing finally has a privacy-policy URL
  to point at.
- Added: the credential field now says out loud that Jianguoyun wants an *application password*
  rather than your login password; both user documents were updated to match.
- Changed: the three sponsor lines were reworded into something gentler, aligned separately in each
  language instead of translated word for word.
- Changed: the outward documentation was rebuilt against a reference layout and the screenshots are
  genuinely in the repository now; the icon set gained the four sizes Edge requires.
- Note: the publishing pipeline only retries failures that look like connectivity. A wrong
  credential fails once, immediately, and says which kind of problem it was.

## [1.9.1] - 2026-10-06

- Changed: the product is now 师兄收纳 **ShiTab**. The names frozen into the storage format did not
  change, so an existing install keeps its data.
- Added: the About pane shows both repository links, each spelled out on its own line so it can be
  copied.

## [1.9.0] - 2026-10-06

- Fixed: the collapse guard only watches the *push* direction now. Pulling was being blocked by it
  too, which meant the machine with fewer sessions could never fetch the other one's data — found
  by testing it in a browser, not in a unit test.
- Added: the unusual-change notice reports four numbers on two axes — sessions and records, this
  machine and the server.
- Changed: the trash panel shares the same shell as the session list, scrolls inside itself, and
  lets a long title be narrowed instead of pushing the row wider.
- Performance: the search cache now expires per session rather than globally, and reading every
  session was folded into a single round trip.
- Added: the settings page got its status announcements too, so a successful import is no longer
  silent.

## [1.8.0] - 2026-10-06

- Changed: the settings page became five sections in a left-hand rail with deep links you can share
  (`#sync` and friends), and the page header went away so the content starts higher.

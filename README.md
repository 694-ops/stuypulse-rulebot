# stuypulse-rulebot

A Slack bot that replies to rule numbers like `G101` or `R203` with the rule's title and a link to it on [frcmanual.com](https://www.frcmanual.com). Mention it in a channel or DM it.

## Keeping the rules current

The bot answers from `rules.json`, which lists every rule number with its title and link.

The [Update rules](.github/workflows/update-rules.yml) GitHub Action rebuilds that file from frcmanual.com every 6 hours. It commits whenever something changed, and Vercel redeploys the bot from that commit. It picks up:

- Team Updates that add, remove or rename rules during the season.
- The next season's manual once frcmanual.com posts it after kickoff. The bot switches over as soon as that manual has its rule sections up.

To update right away, open **Actions > Update rules > Run workflow**.

If frcmanual.com changes its page layout and the scrape comes back with far fewer rules, the run fails and `rules.json` is left as it was. GitHub emails the repo owner about the failed run. The fix is in `scripts/update-rules.mjs`, which reads each rule from the `<h3 id="g101-...">` headings on the section pages.

To run it yourself:

```
node scripts/update-rules.mjs
```

It needs Node 18 or newer and has no dependencies.

# The app uses local copies of the tune data rather than pulling from the CDN.
#	This can be useful for debugging but also just saves hammering the bandwidth
#	quota when doing lots of debugging.
#	This script should be run once to sync the local copies with what is hosted.
#
# The index is published as one file per dataset (thesession / folkwiki /
# norbeck) plus datasets.json listing them. `folkfriend-non-user-data.json` and
# `nud-meta.json` are the legacy single-blob form, still served for installed
# apps that predate dataset selection — and still needed here, because the Rust
# integration tests and the e2e recovery test both read them.
set -e

mkdir -p public/res/
cd public/res/

BASE=https://folkfriend-data.web.app

fetch () {
	name="$1"
	required="$2"
	tmp="$(mktemp "$name.tmp.XXXXXX")"
	if wget -q -O "$tmp" "$BASE/$name"; then
		mv "$tmp" "$name"
		echo "  fetched $name ($(wc -c < "$name" | tr -d ' ') bytes)"
	else
		rm -f "$tmp"
		if [ "$required" = required ]; then
			echo "  FAILED to fetch $name" >&2
			exit 1
		fi
		# Never clobber a good local copy with nothing. An optional file that
		# is not on the CDN yet simply stays as it was.
		echo "  skipped $name (not available)" >&2
	fi
}

fetch datasets.json required
fetch nud-meta.json required
fetch folkfriend-non-user-data.json required

# Per-dataset files, read by the app's multi-dataset path and by the Rust
# tests. Optional so that a checkout still works against a CDN that has not
# been redeployed yet — the tests skip when a dataset file is absent.
for name in $(python3 -c "
import json
with open('datasets.json') as f:
    for entry in json.load(f)['datasets']:
        print(entry['filename'])
" 2>/dev/null); do
	fetch "$name"
done

cd -

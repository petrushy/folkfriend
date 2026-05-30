# The app uses a local copy of the files nud-meta.json and folkfriend-non-user-data.json rather than pulling from the bucket.
#	This can be useful for debugging but also just saves hammering the bandwidth quota when doing lots of debugging.
#	This script should be run once to sync the local copies of these files with the version hosted online.
set -e

mkdir -p public/res/
cd public/res/

tmp_meta="$(mktemp nud-meta.json.tmp.XXXXXX)"
tmp_data="$(mktemp folkfriend-non-user-data.json.tmp.XXXXXX)"
cleanup() {
    rm -f "$tmp_meta" "$tmp_data"
}
trap cleanup EXIT

# Data lives in a completely separate Firebase project.
wget -O "$tmp_meta" https://folkfriend-data.web.app/nud-meta.json
wget -O "$tmp_data" https://folkfriend-data.web.app/folkfriend-non-user-data.json

mv "$tmp_meta" nud-meta.json
mv "$tmp_data" folkfriend-non-user-data.json

cd -

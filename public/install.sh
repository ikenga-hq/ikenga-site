#!/usr/bin/env sh
# install.sh — Ikenga installer (macOS incl. Apple Silicon · Linux x86_64 ·
#              Windows x64 under bash).
#
# Usage (macOS / Linux):
#   curl -fsSL https://ikenga.dev/install.sh | sh
#
# Usage (Windows under Git Bash / MSYS / Cygwin):
#   curl -fsSL https://ikenga.dev/install.sh | sh
#
# Environment overrides:
#   IKENGA_VERSION       Pin a release tag (default: latest published).
#   IKENGA_INSTALL_DIR   Linux portable install dir (default: $HOME/.local/bin).
#                        Ignored when IKENGA_FORMAT=deb (system install).
#   IKENGA_FORMAT        Linux installer format: deb or appimage. Default is
#                        deb when dpkg is present (a ~22 MB system install) and
#                        appimage otherwise (a ~110 MB no-sudo portable build).
#                        deb requires dpkg + apt-get; sudo prompts are not
#                        auto-run under `curl … | sh`, so the script prints
#                        the apt-get command for you to paste with sudo.
#   IKENGA_REPO          Source repo (default: ikenga-hq/ikenga).
#   IKENGA_SILENT        Windows: set to 1 to run the NSIS installer with /S
#                        (no UI, system-default install dir). Default: 0.
#
# This script is meant to be safe under `curl … | sh` (non-interactive, no
# `read`, no surprise sudo). It prints clear messages and exits non-zero on
# any unsupported OS / arch / missing-release condition.

set -eu

REPO="${IKENGA_REPO:-ikenga-hq/ikenga}"
VERSION="${IKENGA_VERSION:-latest}"
# `auto` is resolved per-OS below (Linux: deb when dpkg is present, else
# appimage). An explicit IKENGA_FORMAT=deb|appimage overrides the auto choice.
FORMAT="${IKENGA_FORMAT:-auto}"

# ─── colour helpers ────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
	bold="$(tput bold)"; dim="$(tput dim)"; reset="$(tput sgr0)"
	ember="$(tput setaf 1)"; amber="$(tput setaf 3)"
else
	bold=""; dim=""; reset=""; ember=""; amber=""
fi

say()  { printf '%s%s%s\n' "$bold" "$1" "$reset"; }
hint() { printf '%s%s%s\n' "$dim"  "$1" "$reset"; }
warn() { printf '%s%s%s\n' "$amber" "$1" "$reset" >&2; }
fail() { printf '%s%s%s\n' "$ember" "$1" "$reset" >&2; exit 1; }

# ─── OS / arch detection ───────────────────────────────────────────────────
uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
	Darwin) os=darwin ;;
	Linux)  os=linux ;;
	MINGW*|MSYS*|CYGWIN*|Windows_NT) os=windows ;;
	*) fail "Unsupported OS: $uname_s" ;;
esac

# arm64 is supported on macOS (native Apple Silicon build). Linux + Windows
# ship x86_64 only today, so those arm64 cases fail gracefully in their
# per-OS blocks below rather than here.
case "$uname_m" in
	x86_64|amd64) arch=amd64 ;;
	arm64|aarch64) arch=arm64 ;;
	*) fail "Unsupported architecture: $uname_m" ;;
esac

# ─── resolve release tag ───────────────────────────────────────────────────
if [ "$VERSION" = "latest" ]; then
	api="https://api.github.com/repos/$REPO/releases/latest"
	tag="$(curl -fsSL "$api" 2>/dev/null | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)"

	if [ -z "$tag" ]; then
		warn "No published release found for $REPO."
		echo
		echo "Ikenga has not yet cut a public release. The download endpoints"
		echo "will become live the first time a release is published on GitHub."
		echo
		hint "Track releases: https://github.com/$REPO/releases"
		hint "Or pin a draft tag explicitly: IKENGA_VERSION=v0.0.4 sh install.sh"
		exit 1
	fi
else
	tag="$VERSION"
fi

ver="${tag#v}"
say "Ikenga $tag — $os/$arch"

# ─── download helper ───────────────────────────────────────────────────────
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t ikenga)"
trap 'rm -rf "$tmp"' EXIT INT TERM

download() {
	url="$1"; out="$2"
	if ! curl -fSL --progress-bar -o "$out" "$url"; then
		fail "Download failed: $url"
	fi
}

# ─── platform install ──────────────────────────────────────────────────────
if [ "$os" = "darwin" ]; then
	# Releases ship ONE universal (arm64 + x86_64) DMG — there are no per-arch
	# DMGs — so $arch does not change the asset name on macOS.
	asset="Ikenga_${ver}_universal.dmg"
	url="https://github.com/$REPO/releases/download/$tag/$asset"
	echo "→ Downloading $asset"
	hint "  ~40 MB over GitHub's CDN."
	download "$url" "$tmp/$asset"

	echo "→ Mounting"
	mount_out="$(hdiutil attach "$tmp/$asset" -nobrowse -readonly -mountrandom "$tmp" 2>&1)"
	# $tmp is passed with -v (not spliced into the awk program): it contains
	# slashes (e.g. /var/folders/…/T/…), which break an /…/ regex literal and
	# made awk exit with a syntax error here, so no mount point was ever found.
	vol="$(printf '%s\n' "$mount_out" | awk -v t="$tmp" 'index($0, "/Volumes/") || index($0, t) {for(i=1;i<=NF;i++) if($i ~ /^\//) print $i}' | tail -1)"
	[ -d "$vol" ] || fail "Could not determine mount point for $asset"

	app="$(find "$vol" -maxdepth 2 -name '*.app' -print -quit)"
	[ -n "$app" ] || { hdiutil detach "$vol" -quiet 2>/dev/null || true; fail "No .app found inside DMG"; }

	dest_dir="/Applications"
	dest="$dest_dir/$(basename "$app")"

	if [ ! -w "$dest_dir" ]; then
		warn "$dest_dir is not writable by this user."
		warn "Drag $(basename "$app") to /Applications manually, then close this window."
		echo
		open "$vol" || true
		# Detach later — give user a moment.
		sleep 30
		hdiutil detach "$vol" -quiet 2>/dev/null || true
		exit 1
	fi

	[ -d "$dest" ] && { echo "→ Replacing existing $dest"; rm -rf "$dest"; }
	echo "→ Installing to $dest"
	cp -R "$app" "$dest_dir/"
	hdiutil detach "$vol" -quiet 2>/dev/null || true

	# Ikenga is not yet code-signed, so macOS shows a Gatekeeper prompt the
	# first time the app is opened. This script does not change that; it only
	# tells the user how to proceed.
	echo
	say "Ikenga is installed."
	echo
	echo "Ikenga is not yet code-signed, so macOS will show a Gatekeeper prompt the first time you open it."
	hint "  To open it anyway: right-click Ikenga in Applications and choose Open,"
	hint "  or go to System Settings > Privacy & Security and click Open Anyway."
	echo
	echo "Launch with: open -a Ikenga"
fi

if [ "$os" = "linux" ]; then
	if [ "$arch" = "arm64" ]; then
		warn "Ikenga doesn't ship a prebuilt arm64 Linux build yet — x86_64 only."
		echo
		hint "Build from source: git clone https://github.com/$REPO"
		hint "Track arm64 Linux:  https://github.com/$REPO/issues"
		exit 1
	fi
	# Resolve the `auto` default: prefer the smaller .deb when dpkg is present
	# (a ~22 MB system install) over the ~110 MB no-sudo AppImage. The AppImage
	# is ~5× larger and reads as a "hang" on a slow connection, so it's the
	# fallback, not the default. An explicit IKENGA_FORMAT wins either way.
	if [ "$FORMAT" = "auto" ]; then
		if command -v dpkg >/dev/null 2>&1; then
			FORMAT=deb
		else
			FORMAT=appimage
		fi
	fi

	case "$FORMAT" in
		appimage)
			asset="Ikenga_${ver}_amd64.AppImage"
			url="https://github.com/$REPO/releases/download/$tag/$asset"

			dir="${IKENGA_INSTALL_DIR:-$HOME/.local/bin}"
			bin="$dir/ikenga"

			echo "→ Downloading $asset"
			hint "  ~110 MB over GitHub's CDN — this can take a few minutes; it isn't stuck."
			if command -v dpkg >/dev/null 2>&1; then
				hint "  (Smaller system install available: IKENGA_FORMAT=deb — ~22 MB.)"
			fi
			mkdir -p "$dir"
			download "$url" "$bin"
			chmod +x "$bin"

			echo
			say "Ikenga is installed at $bin"

			case ":${PATH:-}:" in
				*":$dir:"*) echo "Launch with: ikenga" ;;
				*)
					hint "Note: $dir is not on your PATH."
					hint "Add it (bash/zsh):"
					hint "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile"
					echo
					echo "Or launch directly: $bin"
					;;
			esac

			if command -v dpkg >/dev/null 2>&1; then
				echo
				hint "Prefer a system-wide .deb install? Re-run with IKENGA_FORMAT=deb:"
				hint "  curl -fsSL https://ikenga.dev/install.sh | IKENGA_FORMAT=deb sh"
			fi
			;;

		deb)
			if ! command -v dpkg >/dev/null 2>&1; then
				fail "IKENGA_FORMAT=deb requires dpkg, which isn't installed. Try IKENGA_FORMAT=appimage."
			fi

			asset="Ikenga_${ver}_amd64.deb"
			url="https://github.com/$REPO/releases/download/$tag/$asset"
			# Download to /tmp (not $tmp) so the file outlives this script's
			# exit trap — the user needs to run `sudo apt-get install` after
			# the script returns, and $tmp gets wiped on EXIT.
			out="/tmp/$asset"

			echo "→ Downloading $asset"
			hint "  ~22 MB over GitHub's CDN, then one sudo paste to install."
			hint "  (Prefer a no-sudo portable build? Re-run with IKENGA_FORMAT=appimage — ~110 MB.)"
			download "$url" "$out"

			echo
			say "Downloaded $asset → $out"
			echo "To install, run with sudo (curl|sh can't prompt for a password):"
			echo
			if command -v apt-get >/dev/null 2>&1; then
				echo "  sudo apt-get install -y $out"
			else
				echo "  sudo dpkg -i $out"
				hint "  (dpkg won't auto-resolve deps; if it complains, install them via your distro's package manager.)"
			fi
			echo
			hint "After install: launch from your app menu, or run \`ikenga\` from a terminal."
			;;

		*)
			fail "Unknown IKENGA_FORMAT: $FORMAT (expected appimage or deb)"
			;;
	esac
fi

if [ "$os" = "windows" ]; then
	if [ "$arch" = "arm64" ]; then
		warn "Ikenga ships a Windows x64 installer only (no native arm64 yet)."
		hint "On Windows on ARM the x64 build runs under emulation — download it manually:"
		hint "  https://github.com/$REPO/releases/latest"
		exit 1
	fi
	asset="Ikenga_${ver}_x64-setup.exe"
	url="https://github.com/$REPO/releases/download/$tag/$asset"

	# Prefer a Windows-visible Downloads dir so users can find / re-run the
	# installer later. Fall back to a /tmp path if USERPROFILE isn't set.
	if [ -n "${USERPROFILE:-}" ]; then
		# Translate Windows path → MSYS-style if needed.
		win_home="$USERPROFILE"
		case "$win_home" in
			/c/*|/[A-Za-z]/*) ;; # already MSYS-style
			*) win_home="$(cygpath -u "$win_home" 2>/dev/null || echo "$win_home")" ;;
		esac
		downloads="$win_home/Downloads"
		mkdir -p "$downloads" 2>/dev/null || downloads="$tmp"
	else
		downloads="$tmp"
	fi

	out="$downloads/$asset"
	echo "→ Downloading $asset → $out"
	download "$url" "$out"

	# Run the NSIS installer. Silent mode (/S) installs to the system default
	# location with no UI; interactive mode (default) shows the standard
	# Windows installer wizard.
	silent_flag=""
	[ "${IKENGA_SILENT:-0}" = "1" ] && silent_flag="//S"  # double-slash so MSYS doesn't path-translate

	echo "→ Launching installer"
	# `start "" path` returns immediately; the installer runs detached. Wrap
	# in `cmd //c` so we work under Git Bash / MSYS where `start` isn't a
	# native command.
	if command -v cmd >/dev/null 2>&1; then
		win_out="$(cygpath -w "$out" 2>/dev/null || echo "$out")"
		cmd //c start "" "$win_out" $silent_flag || \
			fail "Installer launch failed. Run it manually: $out"
	else
		# Last-resort: just point at the file.
		warn "cmd.exe not found; cannot auto-launch."
		warn "Run the installer manually: $out"
		exit 1
	fi

	echo
	say "Ikenga installer running."
	if [ "${IKENGA_SILENT:-0}" = "1" ]; then
		echo "Silent install: launches once the installer completes."
		echo "Default location: C:\\Users\\<you>\\AppData\\Local\\Programs\\Ikenga\\"
	else
		echo "Follow the installer wizard, then launch Ikenga from the Start menu."
	fi
	echo
	hint "Installer saved at: $out (re-run anytime)"
fi

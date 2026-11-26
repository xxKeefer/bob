# Installer: install script, not a single executable

Choice: a release tarball plus `install.sh`, which checks for Node 26 and links `bob`.

Reason: `node:sqlite` is only guaranteed on a real Node 26, and a single executable (SEA) would embed Node and cost a build matrix per platform. The script is cheap and ships the same files as the source.

Cost: a machine needs Node 26 first. The issue's "runs on a machine with no Node" is not met by design.

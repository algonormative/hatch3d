# Private native preparation adapter

`hatch3d-plotprep-node-0.1.0.tgz` is the exact packed artifact from
`/Users/chronick-mbp/git/vpype-rs/node` at commit `7cdd9c3`. Its SHA-256 is
`957b237be392aa1a64d082aa10167f98028066b9054aa2a19b98bc7cc1d53af4`.
The Hatch3D root installs this local tarball for the host build. The host build
bundles the adapter into its Node entry points; consumers still install only
the packed plot-core and plot-host packages plus their declared runtime
dependencies. The native `plotprep` executable is separate and is never
included in the host package.

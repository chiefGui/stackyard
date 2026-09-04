# stackyard

## 0.2.0

### Minor Changes

- feat: capture bounded resource logs ([#20](https://github.com/chiefGui/stackyard/pull/20))
- feat: separate daemon and project lifecycle commands ([#27](https://github.com/chiefGui/stackyard/pull/27))
- refactor!: establish the dashboard application foundation ([#11](https://github.com/chiefGui/stackyard/pull/11))
- feat: keep every project visible and run its current definition ([#25](https://github.com/chiefGui/stackyard/pull/25))
- feat: keep Stackyard running until you stop it ([#26](https://github.com/chiefGui/stackyard/pull/26))
- feat: refresh the dashboard interface ([#28](https://github.com/chiefGui/stackyard/pull/28))
- feat: remember local projects across sessions and keep their definitions current automatically ([#22](https://github.com/chiefGui/stackyard/pull/22))
- feat: add `stackyard --version` and `stackyard -v` ([#18](https://github.com/chiefGui/stackyard/pull/18))
- feat: stream live and recently completed resource logs through a resumable local API ([#21](https://github.com/chiefGui/stackyard/pull/21))

### Patch Changes

- fix: return the conventional interrupt status from attached runs ([#33](https://github.com/chiefGui/stackyard/pull/33))
- refactor: manage daemon resources with effect scopes ([#31](https://github.com/chiefGui/stackyard/pull/31))
- refactor: adopt an effect service for project evaluation ([#30](https://github.com/chiefGui/stackyard/pull/30))
- fix: keep project identity stable across windows path aliases ([#34](https://github.com/chiefGui/stackyard/pull/34))

## 0.1.0

### Minor Changes

- Publish the first public Stackyard release with project inspection, managed local processes, and a machine-global dashboard. ([#12](https://github.com/chiefGui/stackyard/pull/12))

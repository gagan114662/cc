import * as React from 'react'
import { CompanyMissionControl } from '../../components/company/CompanyMissionControl.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <CompanyMissionControl onDone={onDone} />
}

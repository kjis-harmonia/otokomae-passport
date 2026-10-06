export interface OperatorSession {
  operatorToken: string
  staffMemberId: string
  memberName: string
  role: 'staff' | 'manager'
  expiresAt: string
}

let _currentOperator: OperatorSession | null = null

export function getCurrentOperator(): OperatorSession | null {
  if (!_currentOperator) return null
  if (new Date(_currentOperator.expiresAt) <= new Date()) {
    _currentOperator = null
    return null
  }
  return _currentOperator
}

export function setCurrentOperator(op: OperatorSession): void {
  _currentOperator = op
}

export function clearCurrentOperator(): void {
  _currentOperator = null
}

export function isCurrentOperatorValid(): boolean {
  return getCurrentOperator() !== null
}

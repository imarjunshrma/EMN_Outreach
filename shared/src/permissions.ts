export type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'VIEWER';

const RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, MANAGER: 2, ADMIN: 3, OWNER: 4 };

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export const ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];

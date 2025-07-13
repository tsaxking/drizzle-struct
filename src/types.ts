export enum PropertyAction {
	Read = 'read',
	Update = 'update',
	ReadArchive = 'read-archive',
	ReadVersionHistory = 'read-version-history',
	SetAttributes = 'set-attributes', // ADMIN ONLY
}

// these are not property specific
export enum DataAction {
	Create = 'create',
	Delete = 'delete',
	Archive = 'archive',
	RestoreArchive = 'restore-archive',
	RestoreVersion = 'restore-version',
	DeleteVersion = 'delete-version',
	// ReadVersionHistory = 'read-version-history',
	// ReadArchive = 'read-archive'
}

export type ColType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'array'
	| 'json'
	| 'date'
	| 'bigint'
	| 'custom'
	| 'buffer';

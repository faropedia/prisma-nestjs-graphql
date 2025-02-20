import JSON5 from 'json5';
import { isObject, merge, omit, trim } from 'lodash';
import outmatch from 'outmatch';
import { PlainObject } from 'simplytyped';

import { GeneratorConfiguration } from '../types';

export type ObjectSetting = {
    /**
     * Act as named import or namespaceImport or defaultImport
     */
    name: string;
    kind: 'Decorator' | 'FieldType' | 'PropertyType' | 'ObjectType';
    arguments?: string[] | Record<string, unknown>;
    input: boolean;
    output: boolean;
    model: boolean;
    match?: (test: string) => boolean;
    from: string;
    namespace?: string;
    defaultImport?: string | true;
    namespaceImport?: string;
    namedImport?: boolean;
};

interface ObjectSettingsFilterArgs {
    name: string;
    input?: boolean;
    output?: boolean;
}

export class ObjectSettings extends Array<ObjectSetting> {
    shouldHideField({
        name,
        input = false,
        output = false,
    }: ObjectSettingsFilterArgs): boolean {
        const hideField = this.find(s => s.name === 'HideField');

        return Boolean(
            (hideField?.input && input) ||
                (hideField?.output && output) ||
                hideField?.match?.(name),
        );
    }

    getFieldType({
        name,
        input,
        output,
    }: ObjectSettingsFilterArgs): ObjectSetting | undefined {
        const fieldType = this.find(s => s.kind === 'FieldType');

        if (!fieldType) {
            return undefined;
        }

        if (fieldType.match) {
            // eslint-disable-next-line unicorn/prefer-regexp-test
            return fieldType.match(name) ? fieldType : undefined;
        }

        if (input && !fieldType.input) {
            return undefined;
        }

        if (output && !fieldType.output) {
            return undefined;
        }

        return fieldType;
    }

    getPropertyType({ name }: ObjectSettingsFilterArgs): ObjectSetting | undefined {
        const propertyType = this.find(s => s.kind === 'PropertyType');

        if (!propertyType) {
            return undefined;
        }

        // eslint-disable-next-line unicorn/prefer-regexp-test
        if (propertyType.match && !propertyType.match(name)) {
            return undefined;
        }

        return propertyType;
    }

    getObjectTypeArguments(options: Record<string, any>): string[] {
        const objectTypeOptions = merge({}, options);
        const resultArguments: any[] = [objectTypeOptions];
        const objectType = this.find(s => s.kind === 'ObjectType');
        if (objectType && isObject(objectType.arguments)) {
            const name = (objectType.arguments as PlainObject).name;
            merge(objectTypeOptions, omit(objectType.arguments, 'name'));
            if (name) {
                resultArguments.unshift(name);
            }
        }
        return resultArguments.map(x => JSON5.stringify(x));
    }
}

export function createObjectSettings(args: {
    text: string;
    config: GeneratorConfiguration;
}) {
    const { config, text } = args;
    const result = new ObjectSettings();
    const textLines = text.split('\n');
    const documentationLines: string[] = [];
    for (const line of textLines) {
        const match = /^@(?<name>\w+(\.(\w+))?)\((?<args>.*)\)/.exec(line);
        const name = match?.groups?.name;
        if (!match || !name) {
            documentationLines.push(line);
            continue;
        }
        const element: ObjectSetting = {
            kind: 'Decorator',
            name: '',
            arguments: [],
            input: false,
            output: false,
            model: false,
            from: '',
        };
        if (name === 'TypeGraphQL.omit' || name === 'HideField') {
            Object.assign(element, hideFieldDecorator(match));
        } else if (['FieldType', 'PropertyType'].includes(name) && match.groups?.args) {
            const options = customType(match.groups.args);
            merge(
                element,
                options.namespace && config.fields[options.namespace],
                options,
                { kind: name },
            );
        } else if (name === 'ObjectType' && match.groups?.args) {
            element.kind = 'ObjectType';
            const options = customType(match.groups.args) as Record<string, unknown>;
            if (typeof options[0] === 'string' && options[0]) {
                options.name = options[0];
            }
            if (isObject(options[1])) {
                merge(options, options[1]);
            }
            element.arguments = {
                name: options.name,
                isAbstract: options.isAbstract,
            };
        } else if (name === 'Directive' && match.groups?.args) {
            const options = customType(match.groups.args);
            merge(element, { model: true, from: '@nestjs/graphql' }, options, {
                name,
                namespace: false,
                kind: 'Decorator',
                arguments: Array.isArray(options.arguments)
                    ? options.arguments.map(s => JSON5.stringify(s))
                    : options.arguments,
            });
        } else {
            const namespace = getNamespace(name);
            element.namespaceImport = namespace;
            const options = {
                name,
                arguments: (match.groups?.args || '')
                    .split(',')
                    .map(s => trim(s))
                    .filter(Boolean),
            };
            merge(element, namespace && config.fields[namespace], options);
        }
        result.push(element);
    }

    return {
        settings: result,
        documentation: documentationLines.filter(Boolean).join('\\n') || undefined,
    };
}

function customType(args: string) {
    const result: Partial<ObjectSetting> = {};
    let options = parseArgs(args);
    if (typeof options === 'string') {
        options = { name: options };
    }
    Object.assign(result, options);
    const namespace = getNamespace(options.name);
    result.namespace = namespace;
    if ((options as { name: string | undefined }).name?.includes('.')) {
        result.namespaceImport = namespace;
    }

    if (typeof options.match === 'string' || Array.isArray(options.match)) {
        result.match = outmatch(options.match, { separator: false });
    }

    return result;
}

function hideFieldDecorator(match: RegExpExecArray) {
    const result: Partial<ObjectSetting> = {
        name: 'HideField',
        arguments: [],
        from: '@nestjs/graphql',
        defaultImport: undefined,
        namespaceImport: undefined,
        match: undefined,
    };
    if (!match.groups?.args) {
        result.output = true;
        return result;
    }

    if (match.groups.args.includes('{') && match.groups.args.includes('}')) {
        const options = parseArgs(match.groups.args) as Record<string, unknown>;
        result.output = Boolean(options.output);
        result.input = Boolean(options.input);
        if (typeof options.match === 'string' || Array.isArray(options.match)) {
            result.match = outmatch(options.match, { separator: false });
        }
    } else {
        if (/output:\s*true/.test(match.groups.args)) {
            result.output = true;
        }
        if (/input:\s*true/.test(match.groups.args)) {
            result.input = true;
        }
    }

    return result;
}

function parseArgs(string: string): Record<string, unknown> | string {
    try {
        return JSON5.parse(string);
    } catch {
        try {
            return JSON5.parse(`[${string}]`);
        } catch {
            throw new Error(`Failed to parse: ${string}`);
        }
    }
}

function getNamespace(name: unknown): string | undefined {
    if (name === undefined) {
        return undefined;
    }
    let result = String(name);
    if (result.includes('.')) {
        [result] = result.split('.');
    }
    // eslint-disable-next-line consistent-return
    return result;
}

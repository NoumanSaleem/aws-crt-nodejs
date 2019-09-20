/*
 * Copyright 2010-2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

import child_process from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Runs a shell command and checks for success.
 * If the command returned 0, the promise is resolved with stdout.
 * If the command returned non-0, stderr is logged and passed to the promise's exception handler.
 * @param command Shell command to run
 */
async function run_and_check(command: string) {
    return new Promise<string>((resolve, reject) => {
        child_process.exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(stdout);
                console.error(stderr);
                reject(error);
            }
            resolve(stdout);
        });
    });
}

const is_64bit = process.arch == 'x64' || process.arch == 'arm64';
const is_32bit = process.arch == 'x32' || process.arch == 'arm';

const is_windows = process.platform == 'win32';
const is_macos = process.platform == 'darwin';

const cmake_config = process.argv.indexOf('--debug') != -1 ? 'Debug' : 'Release';

const cross_compile_flags: string = (() => {
    let flags: string[] = [];

    if (is_32bit && !is_windows) {
        flags.push('-DCMAKE_C_FLAGS=-m32');
    }
    if (is_macos) {
        flags.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=10.7');
    }

    return flags.join(' ');
})();

/**
 * Detects installed Visual Studio version for CMake's -G flags
 */
async function get_generator_string(): Promise<string | null> {
    return new Promise(async (resolve) => {
        if (!is_windows) {
            resolve(null);
        } else {
            const prog_x86_path = process.env['PROGRAMFILES(x86)'] as string;
            let vs_version_gen_str: string | undefined;
            let x64_arch_str: string
            x64_arch_str = ''

            if (fs.existsSync(path.join(prog_x86_path, 'Microsoft Visual Studio', '2019'))) {
                vs_version_gen_str = 'Visual Studio 16.0 2019';
                x64_arch_str = '-A x64';
                console.log('found installed version of Visual Studio 2019');
            } else if (fs.existsSync(path.join(prog_x86_path, 'Microsoft Visual Studio', '2017'))) {
                vs_version_gen_str = 'Visual Studio 15 2017';
                x64_arch_str = 'Win64'
                console.log('found installed version of Visual Studio 2017');
            } else if (fs.existsSync(path.join(prog_x86_path, 'Microsoft Visual Studio 14.0'))) {
                vs_version_gen_str = 'Visual Studio 14 2015';
                x64_arch_str = 'Win64'
                console.log('found installed version of Visual Studio 2015');
            } 

            if (!vs_version_gen_str) {
                console.error('CMake does not recognize an installed version of visual studio on your system.');
                process.exit(1);
            }

            if (is_64bit) {
                console.log('64bit version of node detected, using win64 builds')
                vs_version_gen_str = vs_version_gen_str + ' ' + x64_arch_str;
            }

            vs_version_gen_str = '-G \"' + vs_version_gen_str + '\"';
            console.log('Succesfully determined generator as ', vs_version_gen_str);
            resolve(vs_version_gen_str);
        }
    });
}

/** The root package directory (assumes running from dist/scripts) */
const current_dir = path.resolve(__dirname, '..', '..');
/** The directory dependencies will be built into */
const build_dir = path.join(current_dir, 'deps_build');

// Create the build directory if it doesn't exist, and cd into it
if (!fs.existsSync(build_dir)) {
    fs.mkdirSync(build_dir);
}
process.chdir(build_dir);

// If user provides AWS_C_INSTALL environment variable, use that instead of dependeny build path
const dep_install_path = process.env.AWS_C_INSTALL || path.join(build_dir, 'install');

let lib_dir = 'lib';
if (fs.existsSync(path.join(dep_install_path, 'lib64'))) {
    lib_dir = 'lib64';
}

/**
 * Uses CMake to configure and build a dependency from its submodule.
 * @param lib_name The name of the dependency to build
 * @param cmake_args Extra CMake args to pass to the configure step
 */
async function build_dependency(lib_name: string, ...cmake_args: string[]) {
    const lib_source_dir = path.join(current_dir, lib_name);
    // Skip library if it wasn't pulled
    if (!fs.existsSync(path.join(lib_source_dir, 'CMakeLists.txt'))) {
        console.log('skipping', lib_name);
        lib_dir = 'lib';
        return;
    }

    const lib_build_dir = path.join(build_dir, lib_name);
    if (!fs.existsSync(lib_build_dir)) {
        fs.mkdirSync(lib_build_dir)
    }
    process.chdir(lib_build_dir)

    const config_cmd = [
        'cmake',
        await get_generator_string(),
        cross_compile_flags,
        '-DCMAKE_PREFIX_PATH=' + dep_install_path,
        '-DCMAKE_INSTALL_PREFIX=' + dep_install_path,
        '-DBUILD_SHARED_LIBS=OFF',
        '-DBUILD_TESTING=OFF',
        '-DCMAKE_INSTALL_LIBDIR=' + lib_dir,
        `-DCMAKE_BUILD_TYPE=${cmake_config}`,
        cmake_args.join(' '),
        lib_source_dir,
    ].join(' ');
    const build_cmd = ['cmake', '--build', './', '--config', cmake_config.toLowerCase(), '--target', 'install'].join(' ');

    await run_and_check(config_cmd);
    await run_and_check(build_cmd);

    process.chdir(build_dir);
}

(async () => {
    try {
        if (process.platform != 'darwin' && !is_windows) {
            await build_dependency('s2n');
        }
        await build_dependency('aws-c-common');
        await build_dependency('aws-c-io');
        await build_dependency('aws-c-compression');
        await build_dependency('aws-c-http');

        await build_dependency('aws-c-mqtt');
        await build_dependency('aws-c-cal');
    } catch (e) {
        console.error(e);
        process.exit(-1);
    }
})();
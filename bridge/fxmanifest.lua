-- testbed-bridge: test operations for redm-testbed. Development servers only.
fx_version 'cerulean'
game 'rdr3'
-- FXServer does not start an rdr3 resource without this exact text.
rdr3_warning 'I acknowledge that this is a prerelease build of RedM, and I am aware my resources *will* become incompatible once RedM ships.'

name 'testbed-bridge'
author 'redm-testbed'
description 'Runs test operations for redm-testbed. Keep testbed_enabled false on a production server.'
version '0.1.0'

server_script 'server.js'
client_script 'client.js'

ui_page 'ui/index.html'

files {
    'ui/index.html',
}

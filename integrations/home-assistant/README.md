# Home Assistant

Home automation API for device control, sensor data, and automation triggers. Popular with self-hosters for unifying
smart home devices under one platform.

## Requirements

- Home Assistant instance (local install, Home Assistant OS, or Docker)
- Long-lived access token

## Setup

1. Go to your HA instance: Profile (bottom-left) > Security > Long-Lived Access Tokens
2. Create a token with a descriptive name (e.g., "AI Agent")
3. Store the token and instance URL in your credential vault:
   ```bash
   op item create --category=login --title="Home Assistant - Token" \
     --vault="Infrastructure" token="your-token" url="http://homeassistant.local:8123"
   ```
4. Test connectivity:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     http://homeassistant.local:8123/api/ | jq
   # Expected: {"message": "API running."}
   ```

## Key Endpoints

| Action          | Method | Endpoint                           | Description                        |
| --------------- | ------ | ---------------------------------- | ---------------------------------- |
| API status      | GET    | `/api/`                            | Check if HA is reachable           |
| All states      | GET    | `/api/states`                      | Every entity and its current state |
| Entity state    | GET    | `/api/states/{entity_id}`          | Single entity state and attributes |
| Call service    | POST   | `/api/services/{domain}/{service}` | Control a device                   |
| Fire event      | POST   | `/api/events/{event_type}`         | Trigger a custom event             |
| History         | GET    | `/api/history/period/{timestamp}`  | Historical state data              |
| Template render | POST   | `/api/template`                    | Render a Jinja2 template           |

## Common Service Calls

```bash
# Turn on a light
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  http://ha:8123/api/services/light/turn_on

# Turn on a light with brightness
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.bedroom", "brightness": 128}' \
  http://ha:8123/api/services/light/turn_on

# Set thermostat temperature
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "climate.main", "temperature": 72}' \
  http://ha:8123/api/services/climate/set_temperature

# Lock/unlock a door
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "lock.front_door"}' \
  http://ha:8123/api/services/lock/lock

# Get a sensor reading
curl -s -H "Authorization: Bearer $TOKEN" \
  http://ha:8123/api/states/sensor.outdoor_temperature | jq '.state'
```

## Entity ID Naming

Home Assistant entities follow the pattern `{domain}.{name}`:

- `light.living_room`, `light.bedroom`
- `switch.office_fan`
- `sensor.outdoor_temperature`, `sensor.indoor_humidity`
- `climate.main_thermostat`
- `lock.front_door`
- `binary_sensor.motion_hallway`

Discover your entity IDs in the HA UI: Developer Tools > States.

## Use Cases

- Controlling lights, locks, and climate from automations or voice commands
- Reading sensor data (temperature, humidity, motion, power usage)
- Triggering HA automations from external events (e.g., "arriving home" via geofence)
- Building morning/evening routines that combine smart home actions with briefings
- Monitoring home security status (doors, windows, motion sensors)

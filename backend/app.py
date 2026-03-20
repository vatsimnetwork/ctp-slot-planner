from flask import Flask, jsonify, request
from dotenv import load_dotenv
from backend.auth import validate_session
load_dotenv()
app = Flask(__name__)

@app.route('/slotgroups/', methods=['GET'])
def get_slot_groups():
    user = validate_session(request)
    # Placeholder data format based on the one used in the frontend
    slot_groups = [
        {'id': 'BOS_1_A_1_SVO', 'value': 30},
        {'id': 'BOS_2_A_1_SVO', 'value': 30},
        {'id': 'JFK_1_A_1_CDG', 'value': 30},
        {'id': 'JFK_1_A_2_CDG', 'value': 30},
        {'id': 'JFK_1_A_1_SVO', 'value': 30}
    ]
    return jsonify(slot_groups)

if __name__ == '__main__':
    app.run()